import { randomUUID } from 'node:crypto'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  CodingExecutor,
  CodingExecutorCapabilities,
  CodingExecutorEvent,
  CodingExecutorHandle,
  CodingTaskSpec,
  CodingTaskState,
  CodingTaskStatus,
  ExecutorAvailability,
  StartTaskOptions
} from '../contracts'
import { spawnProcess } from '../process/spawn-process'
import { parseNdjson } from '../process/ndjson-stream'
import { validateWorkingDirectory } from '../workspace/validate-directory'
import { formatPermissionDenialWarning } from '../permission-denial'

const DEFAULT_BINARY = 'grok'

/**
 * REGRESSION (clap rejected a prompt starting with "-"): caught live on the
 * very first real Compare run, whose prompt (Company Truth prepended) began
 * with "--- Unternehmenswissen ..." - `grok`'s argument parser (clap, Rust)
 * treated `-p <value>` as ending at the first token starting with a dash
 * and tried to parse the rest as more flags, failing with "unexpected
 * argument ... tip: to pass ... as a value, use '-- ...'". Inserting `--`
 * between `-p` and the value does not work either (clap then treats `--`
 * as ending ALL option parsing, leaving `-p` without its value). The robust
 * fix, mirroring Claude/Codex's own "never put the prompt in argv at all"
 * fix for a different but related class of escaping bug: always write the
 * prompt to a file and pass `--prompt-file <PATH>` (confirmed via
 * `grok --help`), regardless of length - the prompt's content then never
 * touches argument parsing at all, sidestepping this and any similar
 * future edge case (quoting, length) in one fix instead of patching each
 * one as found.
 */
async function writePromptFile(prompt: string, taskId: string): Promise<{ tempFile: string; tempDirectory: string }> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'ai-council-prompt-'))
  const tempFile = join(tempDirectory, `.ai-council-task-${taskId}.md`)
  try {
    await writeFile(tempFile, prompt, 'utf-8')
  } catch (err) {
    await rm(tempDirectory, { recursive: true, force: true })
    throw err
  }
  return { tempFile, tempDirectory }
}

interface TaskRecord {
  state: CodingTaskState
  controller: AbortController
  events: AsyncIterable<CodingExecutorEvent>
}

async function captureOutput(
  binary: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number | null }> {
  const { child, exitCode } = spawnProcess(binary, args, { cwd })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8')
  })
  const code = await exitCode
  return { stdout, exitCode: code }
}

/**
 * Runs the real, locally installed `grok` CLI (xAI's Grok Build) as a child
 * process. Same posture as the other three executors: never reads or
 * replicates the user's own Grok session - a task here just inherits
 * whatever session `grok login` (browser or `--device-code`) already
 * established, the same way running `grok` twice in a terminal does. We
 * never set XAI_API_KEY ourselves, since that would move billing onto a
 * separate API key instead of the user's own SuperGrok/X Premium+ session -
 * the opposite of what this executor is for.
 *
 * Grok Build's CLI surface deliberately mirrors Claude Code's own flag
 * names (`-p`, `--output-format`, `--include-partial-messages`, `--resume`,
 * `-c`/`--continue`) - confirmed live via `grok --help` on the installed
 * 1.0.34 build. `--output-format streaming-messages-json` is documented as
 * "NDJSON in the Anthropic Messages API wire format" - and a live captured
 * run (which failed at the auth step, since no account was available while
 * writing this) already produced a `system`/`init` event and a
 * `result`/`error_during_execution` event in exactly the shape
 * claude-code-cli.ts's mapEvent() already parses (same `type`/`subtype`
 * discriminators, same `is_error`/`total_cost_usd`/`usage.input_tokens`
 * fields). This executor's mapEvent() therefore mirrors Claude's directly.
 * What is NOT independently verified yet (no successful, authenticated run
 * was possible while writing this): the `assistant`/`user`/`stream_event`
 * shapes for an actual tool call, and the precise behavioral boundaries of
 * each `--permission-mode` value below. Re-check both against a real
 * captured Ablaufprotokoll at the first real use, the same way the
 * Antigravity give-up-on-denial bug was only found that way, not guessed.
 */
export class GrokBuildCliExecutor implements CodingExecutor {
  readonly id = 'grok-build-cli'
  private tasks = new Map<string, TaskRecord>()

  constructor(private binary: string = DEFAULT_BINARY) {}

  async detect(): Promise<ExecutorAvailability> {
    let versionResult
    try {
      versionResult = await captureOutput(this.binary, ['--version'], process.cwd())
    } catch {
      return { installed: false, authStatus: 'unknown' }
    }
    if (versionResult.exitCode !== 0) {
      return { installed: false, authStatus: 'unknown' }
    }
    const version = versionResult.stdout.trim() || undefined

    // `grok models` needs no active task/session and prints the literal
    // text "You are not authenticated." when logged out (confirmed live,
    // exit code 0 either way - the exit code alone isn't a usable signal
    // here, unlike Claude Code's `auth status`).
    let authStatus: ExecutorAvailability['authStatus'] = 'unknown'
    try {
      const authResult = await captureOutput(this.binary, ['models'], process.cwd())
      authStatus = authResult.stdout.toLowerCase().includes('not authenticated') ? 'unauthenticated' : 'authenticated'
    } catch {
      authStatus = 'unknown'
    }

    return { installed: true, version, authStatus }
  }

  capabilities(): CodingExecutorCapabilities {
    return { resumeSession: true, fileEditing: true, shellAccess: true }
  }

  startTask(spec: CodingTaskSpec, options?: StartTaskOptions): CodingExecutorHandle {
    return this.run(spec, options)
  }

  resumeSession(
    sessionId: string,
    spec: CodingTaskSpec,
    options?: StartTaskOptions
  ): CodingExecutorHandle {
    return this.run(spec, options, sessionId)
  }

  streamEvents(taskId: string): AsyncIterable<CodingExecutorEvent> | undefined {
    return this.tasks.get(taskId)?.events
  }

  getStatus(taskId: string): CodingTaskStatus | undefined {
    const record = this.tasks.get(taskId)
    return record ? { taskId, state: record.state } : undefined
  }

  abort(taskId: string): void {
    this.tasks.get(taskId)?.controller.abort()
  }

  private run(spec: CodingTaskSpec, options?: StartTaskOptions, resumeSessionId?: string): CodingExecutorHandle {
    validateWorkingDirectory(spec.workingDirectory)

    const taskId = randomUUID()
    const controller = new AbortController()
    if (options?.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const record: TaskRecord = {
      state: 'running',
      controller,
      events: this.streamProcess(taskId, spec, resumeSessionId, controller, (state) => {
        record.state = state
      })
    }
    this.tasks.set(taskId, record)

    return { taskId, events: record.events }
  }

  private async *streamProcess(
    taskId: string,
    spec: CodingTaskSpec,
    resumeSessionId: string | undefined,
    controller: AbortController,
    setState: (state: CodingTaskState) => void
  ): AsyncGenerator<CodingExecutorEvent> {
    yield { type: 'start', taskId }

    const { args, tempDirectory } = await buildArgs(spec, taskId)
    if (resumeSessionId) args.push('--resume', resumeSessionId)

    try {
      yield* this.runProcess(args, spec.workingDirectory, controller, setState)
    } finally {
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
    }
  }

  private async *runProcess(
    args: string[],
    cwd: string,
    controller: AbortController,
    setState: (state: CodingTaskState) => void
  ): AsyncGenerator<CodingExecutorEvent> {
    const { child, exitCode, killConfirmed } = spawnProcess(this.binary, args, { cwd, signal: controller.signal })
    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000)
    })

    let sawResult = false
    let sawError = false
    let result: Extract<CodingExecutorEvent, { type: 'done' }> | undefined
    const pendingCommands = new Map<string, string>()
    try {
      for await (const raw of parseNdjson(child.stdout)) {
        for (const event of mapEvent(raw, pendingCommands)) {
          if (event.type === 'done') { sawResult = true; result = event }
          else { if (event.type === 'error') { sawError = true; setState('error') }; yield event }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setState('error')
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        for (const [, command] of pendingCommands) yield { type: 'command', command }
        return
      }
    }

    for (const [, command] of pendingCommands) yield { type: 'command', command }
    pendingCommands.clear()

    const code = await exitCode

    if (controller.signal.aborted) {
      setState('aborted')
      if (!killConfirmed()) {
        yield {
          type: 'warning',
          message:
            'Abbruch angefordert, aber der zugrunde liegende Prozess konnte nicht sicher beendet werden - er könnte noch im Hintergrund laufen.'
        }
      }
      return
    }

    if (sawError || code !== 0) {
      setState('error')
      if (!sawError) yield { type: 'error', message: stderrTail.trim() || `grok beendete sich mit Exit-Code ${code}`, code: code === null ? undefined : String(code) }
      return
    }
    if (!sawResult) {
      setState('done')
      if (stderrTail.trim()) {
        yield { type: 'warning', message: stderrTail.trim() }
        yield { type: 'done', summary: '' }
      } else {
        yield { type: 'done', summary: '' }
      }
    } else {
      setState('done')
      if (result) yield result
    }
  }
}

/**
 * REGRESSION (live, first real Council/Compare run with a genuinely
 * research-y prompt): the original mapping below used `--permission-mode
 * plan` for 'read-only'. Live-verified against the real installed,
 * authenticated 1.0.34 binary: under `plan` (and also tried live: `dontAsk`),
 * a tool that still requires interactive confirmation (`web_fetch` - opening
 * a specific URL) gets auto-cancelled with no TTY to approve it - not denied
 * with a continuable warning the way Claude's read-only tier handles a
 * denial, but a hard `stop_reason: "cancelled"` that aborts the entire task
 * with an `error_during_execution` result. This is the same class of bug as
 * Antigravity's documented give-up-on-any-denial behavior, just triggered by
 * an unapprovable confirmation instead of an explicit deny. `web_search`
 * itself (a server-side tool, billed separately per
 * `usage.server_tool_use.web_search_requests`) was unaffected either way -
 * only `web_fetch` needs this.
 *
 * The fix, live-verified end to end (including confirming a write attempt
 * genuinely fails under the read-only tool list, and genuinely succeeds
 * under the read-write one): always run with `bypassPermissions` (so no
 * tool call is ever blocked on a confirmation nothing can grant), and
 * enforce the actual per-tier restriction via `--tools` (a positive
 * allow-list) instead. `--disallowed-tools` was tried first and rejected -
 * live-verified to silently fail to remove `run_terminal_command` and
 * `spawn_subagent` specifically (every other tool name was removed
 * correctly), so it cannot be trusted as a real restriction here. `--tools`
 * correctly excludes everything not named, confirmed by the model itself
 * reporting "kein Schreib- oder Shell-Tool" available when asked to write a
 * file under the read-only list.
 *
 * Tool names below are Grok Build's own (confirmed live via the
 * `system`/`init` event's `tools` array - snake_case, distinct from Claude
 * Code's PascalCase names like `WebSearch`/`Bash`; `spec.allowedTools` -
 * Claude-specific names - is intentionally ignored here, same as Codex/
 * Antigravity, see agent-participant.ts's doc comment). `scheduler_create`/
 * `scheduler_delete` are deliberately never named in an allow-list here:
 * live-verified that omitting either one while keeping the other (e.g. via
 * --disallowed-tools) breaks session init entirely ("Requirements
 * unsatisfied: ... scheduler_list") - they and `scheduler_list` form a
 * bundle the CLI doesn't expect to be split, and none of the three are
 * needed for a Council/Coding seat's read-only or read-write role anyway.
 */
const READ_ONLY_TOOLS = ['read_file', 'list_dir', 'grep', 'search_tool', 'web_search', 'web_fetch', 'todo_write']
const READ_WRITE_TOOLS = [...READ_ONLY_TOOLS, 'write', 'search_replace']

const ALLOWED_TOOLS_BY_TIER: Record<NonNullable<CodingTaskSpec['permissionTier']>, string[] | undefined> = {
  'read-only': READ_ONLY_TOOLS,
  'read-write': READ_WRITE_TOOLS,
  // No --tools restriction at all - every built-in tool (including
  // run_terminal_command/spawn_subagent/scheduler_*/image_*) is available,
  // same spirit as Antigravity's --dangerously-skip-permissions for 'full'.
  full: undefined
}

async function buildArgs(spec: CodingTaskSpec, taskId: string): Promise<{ args: string[]; tempFile: string; tempDirectory: string }> {
  const args = ['--output-format', 'streaming-messages-json', '--include-partial-messages', '--cwd', spec.workingDirectory]
  if (spec.permissionTier) {
    args.push('--permission-mode', 'bypassPermissions')
    const allowedTools = ALLOWED_TOOLS_BY_TIER[spec.permissionTier]
    if (allowedTools) args.push('--tools', allowedTools.join(','))
  }

  const { tempFile, tempDirectory } = await writePromptFile(spec.prompt, taskId)
  args.push('--prompt-file', tempFile)
  return { args, tempFile, tempDirectory }
}

const SHELL_TOOL_NAMES = new Set(['run_terminal_command'])

/**
 * Maps Grok Build's --output-format streaming-messages-json vocabulary onto
 * CodingExecutorEvent. Deliberately mirrors claude-code-cli.ts's mapEvent()
 * almost verbatim - see the class doc comment above for why. The
 * `system`/`result` branches are confirmed against a real captured event
 * (from a run that failed at the auth step); the `assistant`/`stream_event`/
 * `user` branches are carried over on the strength of the CLI's own
 * documented claim that this format matches Anthropic's Messages API wire
 * format, not independently re-verified against a real successful run yet.
 */
function mapEvent(raw: unknown, pendingCommands: Map<string, string>): CodingExecutorEvent[] {
  if (typeof raw !== 'object' || raw === null) return []
  const obj = raw as Record<string, unknown>

  if (obj.type === 'system' && typeof obj.subtype === 'string') {
    return [{ type: 'status', message: obj.subtype }]
  }

  if (obj.type === 'stream_event' && typeof obj.event === 'object' && obj.event !== null) {
    const event = obj.event as Record<string, unknown>
    if (
      event.type === 'content_block_delta' &&
      typeof event.delta === 'object' &&
      event.delta !== null
    ) {
      const delta = event.delta as Record<string, unknown>
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        return [{ type: 'text', text: delta.text }]
      }
    }
    return []
  }

  if (obj.type === 'assistant' && typeof obj.message === 'object' && obj.message !== null) {
    const message = obj.message as Record<string, unknown>
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
    const events: CodingExecutorEvent[] = []
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        SHELL_TOOL_NAMES.has(block.name) &&
        typeof block.input === 'object' &&
        block.input !== null
      ) {
        const input = block.input as Record<string, unknown>
        if (typeof input.command === 'string') {
          pendingCommands.set(block.id, input.command)
          events.push({ type: 'status', message: `Führt aus: ${input.command}` })
        }
      }
    }
    return events
  }

  if (obj.type === 'user' && typeof obj.message === 'object' && obj.message !== null) {
    const message = obj.message as Record<string, unknown>
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
    const events: CodingExecutorEvent[] = []
    for (const block of content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const command = pendingCommands.get(block.tool_use_id)
        if (command !== undefined) {
          pendingCommands.delete(block.tool_use_id)
          events.push({ type: 'command', command, exitCode: block.is_error === true ? 1 : 0 })
        }
      }
    }
    return events
  }

  if (obj.type === 'result') {
    const events: CodingExecutorEvent[] = []
    if (obj.is_error === true || (typeof obj.subtype === 'string' && obj.subtype.startsWith('error'))) {
      const errors = Array.isArray(obj.errors) ? obj.errors.filter((error): error is string => typeof error === 'string').join('\n') : ''
      return [{ type: 'error', message: errors || (typeof obj.result === 'string' && obj.result.trim()) || `Grok-Auftrag fehlgeschlagen (${obj.subtype ?? 'unbekannter Fehler'}).` }]
    }
    const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : []
    if (denials.length > 0) {
      const names = denials
        .map((d) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>).tool_name : undefined))
        .filter((n): n is string => typeof n === 'string')
      events.push({
        type: 'warning',
        message: formatPermissionDenialWarning('Werkzeug-Aufruf(e)', denials.length, names)
      })
    }
    events.push({
      type: 'done',
      summary: typeof obj.result === 'string' ? obj.result : '',
      sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined
    })
    return events
  }

  return []
}
