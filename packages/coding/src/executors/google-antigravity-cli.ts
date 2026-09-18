import { randomUUID } from 'node:crypto'
import { writeFile, rm, mkdtemp, rmdir } from 'node:fs/promises'
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

const DEFAULT_BINARY = 'agy'

/**
 * Caught live: `agy` is a native .exe (no .cmd shim, confirmed via `where
 * agy`), so a long prompt doesn't hit cmd.exe's ~8191-char limit the way
 * Claude/Codex's globally-installed .cmd shims did - it instead risks
 * Windows CreateProcess's own ~32,767-char total command-line limit, since
 * (unlike Claude/Codex) the prompt has no verified way to travel outside
 * argv for this CLI. 30,000 leaves headroom for the other flags, the
 * working directory, and cross-spawn's quoting - above that, buildArgs()
 * switches to the file-based workaround below instead of failing.
 */
const MAX_PROMPT_LENGTH = 30000

/**
 * Workaround for a prompt over MAX_PROMPT_LENGTH: write it to a private
 * temporary directory outside the project, and hand agy a short reference prompt
 * pointing at it. Verified live: agy's own `view_file` tool reads an
 * arbitrary-length file in full and reasons over its entire content
 * correctly (confirmed with a 40,000-character file and a marker buried in
 * it) - so this carries the complete, unmodified prompt across, unlike
 * summarizing/truncating it, which would have given this one participant a
 * degraded version of the same task the others see in full. Named per-task
 * (not a fixed filename) so two calls never collide and a crash before
 * cleanup never leaves an ambiguous leftover. Keeping it outside the project
 * prevents concurrent read-only reviewers from detecting our own transport
 * file as an unauthorized source change.
 */
function longPromptFileName(taskId: string): string {
  return `.ai-council-task-${taskId}.md`
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
 * Runs the real, locally installed `agy` CLI (Google's Antigravity CLI) as
 * a child process. Same posture as the other two executors: never reads or
 * replicates the user's Google OAuth session - `agy -p ...` just inherits
 * whatever session the user already established by running `agy`
 * interactively once. We never set GEMINI_API_KEY or the
 * `modelProvider: "gemini"` settings.json switch, since that moves billing
 * to a separate API key instead of the user's Google One/Gemini plan - the
 * opposite of what this executor is for.
 */
export class GoogleAntigravityCliExecutor implements CodingExecutor {
  readonly id = 'google-antigravity-cli'
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

    // No documented non-interactive "am I logged in" command was found for
    // this CLI either (same gap as Codex) - a real auth failure still
    // surfaces cleanly as an `error`/denied result from the first task.
    return { installed: true, version, authStatus: 'unknown' }
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

    const cwd = spec.workingDirectory
    const { args, tempFile, tempDirectory } = await buildArgs(spec, taskId)
    if (resumeSessionId) args.push('--conversation', resumeSessionId)

    try {
      yield* this.runProcess(args, cwd, controller, setState)
    } finally {
      if (tempFile) await rm(tempFile, { force: true })
      if (tempDirectory) await rmdir(tempDirectory)
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
    let result: Extract<CodingExecutorEvent, { type: 'done' }> | undefined
    let sawError = false
    try {
      for await (const raw of parseNdjson(child.stdout)) {
        for (const event of mapEvent(raw)) {
          if (event.type === 'done') { sawResult = true; result = event }
          else { if (event.type === 'error') sawError = true; yield event }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setState('error')
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
        return
      }
    }

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
      if (!sawError) yield { type: 'error', message: stderrTail.trim() || `agy beendete sich mit Exit-Code ${code}` }
      return
    }
    if (!sawResult) {
      setState('done')
      if (stderrTail.trim()) {
        // Same reasoning as the matching fix in claude-code-cli.ts: exited
        // cleanly but never produced a `result` message at all, and the
        // stderr captured along the way was previously discarded here,
        // leaving only a silent, empty "done" with no hint why. Caught
        // live: a reviewer turn on this exact executor ended with no
        // recoverable JSON verdict, twice in a row.
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

async function buildArgs(spec: CodingTaskSpec, taskId: string): Promise<{ args: string[]; tempFile?: string; tempDirectory?: string }> {
  let prompt = spec.prompt
  let tempFile: string | undefined
  let tempDirectory: string | undefined
  if (prompt.length > MAX_PROMPT_LENGTH) {
    const fileName = longPromptFileName(taskId)
    tempDirectory = await mkdtemp(join(tmpdir(), 'ai-council-prompt-'))
    tempFile = join(tempDirectory, fileName)
    try { await writeFile(tempFile, spec.prompt, 'utf-8') }
    catch (err) { await rm(tempFile, { force: true }); await rmdir(tempDirectory); throw err }
    prompt = `Lies die Datei ${JSON.stringify(tempFile)} vollständig - sie enthält die eigentliche Aufgabe. Der zusätzliche temporäre Ordner dient nur zum Lesen dieser Anweisung. Das eigentliche Projekt ist ${JSON.stringify(spec.workingDirectory)}. Befolge ausschließlich die Anweisungen der Datei, einschließlich des verlangten Antwortformats.`
  }

  // Unlike Claude/Codex, agy does not infer its workspace from the child
  // process's OS working directory - verified live: without --add-dir it
  // reports no project folder open at all and asks the user to specify a
  // path, even when cwd is set correctly. --add-dir (confirmed via
  // `agy --help` and a live run listing real files back) is what actually
  // registers the directory as the workspace it can read/search/edit -
  // also what makes the file-reference workaround above reachable by agy's
  // own file tools.
  const args = ['-p', prompt, '--add-dir', spec.workingDirectory, '--output-format', 'stream-json']
  if (tempDirectory) args.push('--add-dir', tempDirectory)
  // No documented per-tool allow-list flag (unlike Claude's --allowedTools) -
  // only a blanket auto-approve-everything switch. read-only stays on the
  // CLI's own default ("request-review" mode), which in a verified live run
  // already let read-only-ish tools (list_dir, find_by_name, grep_search)
  // through without prompting and only gated run_command/file writes - a
  // limited default. read-write also retains the CLI's own approval gates;
  // unattended writes may therefore require additional CLI support.
  // A limited DEV request must never silently become unrestricted approval.
  if (spec.permissionTier === 'full') {
    args.push('--dangerously-skip-permissions')
  }
  return { args, tempFile, tempDirectory }
}

/**
 * Maps agy's --output-format stream-json vocabulary onto
 * CodingExecutorEvent. Verified against two real captured runs (a trivial
 * response, and a run that exercised tool calls and a permission denial) -
 * see the code review discussion this was built from. The envelope's
 * discriminator field is `event` (not `type`, unlike the other two CLIs).
 * Tool types other than `run_command` are surfaced only as generic status/
 * warning messages - their exact per-tool parameter shapes weren't all
 * captured, and guessing field names would risk misreporting them.
 */
function mapEvent(raw: unknown): CodingExecutorEvent[] {
  if (typeof raw !== 'object' || raw === null) return []
  const obj = raw as Record<string, unknown>

  if (obj.event === 'init') {
    return [{ type: 'status', message: 'init' }]
  }

  if (obj.event === 'step_update' && typeof obj.step_update === 'object' && obj.step_update !== null) {
    const step = obj.step_update as Record<string, unknown>
    const stepType = step.step_type
    const state = step.state

    if (stepType === 'agent_response') {
      const textDelta = step.text_delta
      return typeof textDelta === 'string' && textDelta.length > 0 ? [{ type: 'text', text: textDelta }] : []
    }

    if (stepType === 'tool') {
      const toolName = typeof step.tool_name === 'string' ? step.tool_name : 'tool'
      const toolInfo = step.tool_info as Record<string, unknown> | undefined
      const params = toolInfo?.parameters as Record<string, unknown> | undefined
      const commandLine = typeof params?.CommandLine === 'string' ? params.CommandLine : undefined

      if (toolName === 'run_command' && commandLine !== undefined) {
        if (state === 'ACTIVE') return [{ type: 'status', message: `Führt aus: ${commandLine}` }]
        if (state === 'DONE' || state === 'ERROR') {
          return [{ type: 'command', command: commandLine, exitCode: state === 'DONE' ? 0 : 1 }]
        }
        return []
      }

      if (state === 'ACTIVE') return [{ type: 'status', message: `Werkzeug: ${toolName}` }]
      if (state === 'ERROR') {
        const errorInfo = toolInfo?.error as Record<string, unknown> | undefined
        const message = typeof errorInfo?.message === 'string' ? errorInfo.message : `${toolName} fehlgeschlagen`
        return [{ type: 'warning', message }]
      }
      return []
    }

    return []
  }

  if (obj.event === 'result' && typeof obj.result === 'object' && obj.result !== null) {
    const result = obj.result as Record<string, unknown>
    const events: CodingExecutorEvent[] = []
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : []
    if (denied.length > 0) {
      const names = denied
        .map((d) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>).display_name : undefined))
        .filter((n): n is string => typeof n === 'string')
      events.push({
        type: 'warning',
        message: formatPermissionDenialWarning('Aktion(en)', denied.length, names)
      })
    }
    events.push({
      type: 'done',
      summary: typeof result.response === 'string' ? result.response : '',
      sessionId: typeof result.conversation_id === 'string' ? result.conversation_id : undefined
    })
    return events
  }

  return []
}
