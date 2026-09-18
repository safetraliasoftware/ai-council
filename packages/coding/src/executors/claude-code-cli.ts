import { randomUUID } from 'node:crypto'
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

const DEFAULT_BINARY = 'claude'

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
 * Runs the real, locally installed `claude` CLI as a child process. This
 * executor never reads, extracts, or replicates Claude.ai/OAuth
 * credentials - authentication is entirely the CLI's own responsibility
 * (the user runs `claude` interactively once to log in; every task here
 * just inherits that already-established session, the same way running
 * `claude` twice in a terminal does). We deliberately never pass --bare,
 * because bare mode skips OAuth/keychain and requires ANTHROPIC_API_KEY -
 * the opposite of what this executor is for.
 */
export class ClaudeCodeCliExecutor implements CodingExecutor {
  readonly id = 'claude-code-cli'
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

    let authStatus: ExecutorAvailability['authStatus'] = 'unknown'
    try {
      const authResult = await captureOutput(this.binary, ['auth', 'status'], process.cwd())
      // `claude auth status` exits 0 when logged in, 1 when not (documented behavior).
      if (authResult.exitCode === 0) authStatus = 'authenticated'
      else if (authResult.exitCode === 1) authStatus = 'unauthenticated'
    } catch {
      authStatus = 'unknown'
    }

    return { installed: true, version, authStatus }
  }

  capabilities(): CodingExecutorCapabilities {
    return { resumeSession: true, fileEditing: true, shellAccess: true }
  }

  startTask(spec: CodingTaskSpec, options?: StartTaskOptions): CodingExecutorHandle {
    return this.run(buildArgs(spec), spec, options)
  }

  resumeSession(
    sessionId: string,
    spec: CodingTaskSpec,
    options?: StartTaskOptions
  ): CodingExecutorHandle {
    const args = buildArgs(spec)
    args.push('--resume', sessionId)
    return this.run(args, spec, options)
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

  private run(args: string[], spec: CodingTaskSpec, options?: StartTaskOptions): CodingExecutorHandle {
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
      events: this.streamProcess(taskId, args, spec.workingDirectory, spec.prompt, controller, (state) => {
        record.state = state
      })
    }
    this.tasks.set(taskId, record)

    return { taskId, events: record.events }
  }

  private async *streamProcess(
    taskId: string,
    args: string[],
    cwd: string,
    prompt: string,
    controller: AbortController,
    setState: (state: CodingTaskState) => void
  ): AsyncGenerator<CodingExecutorEvent> {
    yield { type: 'start', taskId }

    const { child, exitCode, killConfirmed } = spawnProcess(this.binary, args, {
      cwd,
      signal: controller.signal,
      stdin: prompt
    })
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

    // A shell tool_use whose matching tool_result never arrived (process
    // aborted/killed, or the stream ended abnormally mid-command) must still
    // be reflected in the run's log/history - otherwise a shell command that
    // was actually attempted silently disappears from the record. exitCode
    // stays unset (unknown), unlike the normal 0/1 derived from is_error.
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
      if (!sawError) yield { type: 'error', message: stderrTail.trim() || `claude beendete sich mit Exit-Code ${code}`, code: code === null ? undefined : String(code) }
      return
    }
    if (!sawResult) {
      setState('done')
      if (stderrTail.trim()) {
        // Exited cleanly but never produced a `result` message at all - the
        // stderr captured along the way was previously discarded here,
        // leaving only a silent, empty "done" with no hint why. That later
        // fails opaquely at JSON-verdict parsing ("kein erkennbares
        // JSON-Urteil. Antwort begann mit: ''") with nothing to diagnose
        // from. Caught live on a reviewer turn ending exactly this way.
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

const PERMISSION_TIER_TOOLS: Record<NonNullable<CodingTaskSpec['permissionTier']>, string[]> = {
  'read-only': ['Read', 'Glob', 'Grep'],
  'read-write': ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
  full: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
}

function buildArgs(spec: CodingTaskSpec): string[] {
  // '-' + stdin, not the raw prompt as an argument - see spawn-process.ts's
  // SpawnOptions.stdin doc. Claude's globally-installed .cmd shim has the
  // same double-cmd.exe-layer exposure as Codex's; verified live that
  // `claude -p -` reads the prompt from stdin exactly like `codex exec -`.
  const args = ['-p', '-', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
  // Explicit override wins; otherwise translate the generic permission tier.
  // Leaving both unset means "don't grant anything beyond Claude Code's own
  // out-of-the-box behavior" (fully manual tool approval).
  const allowedTools = spec.allowedTools ?? (spec.permissionTier ? PERMISSION_TIER_TOOLS[spec.permissionTier] : undefined)
  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','))
  }
  return args
}

const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell'])

/**
 * Maps Claude Code's stream-json event vocabulary onto CodingExecutorEvent.
 * `system/*`, `stream_event` text deltas, `assistant` shell tool_use blocks,
 * `user` tool_result messages, and the terminal `result` message (including
 * its `permission_denials` array) are all verified against a real captured
 * run - see the code review discussion this was built from. Other tool
 * types (Edit/Write/Read/etc.) are intentionally not mapped yet - their
 * exact shape wasn't captured in that run, and guessing would risk
 * misreporting what Claude actually did.
 *
 * `pendingCommands` (tool_use_id -> command text) bridges the two-message
 * gap between a shell tool_use being issued and its result arriving later:
 * we emit an immediate `status` when the command starts (for feedback) and
 * the actual `command` event - with a real exit code - only once the
 * matching `user` tool_result shows up. This is per-task state, owned by
 * the caller (streamProcess), not this module - mapEvent stays stateless
 * apart from that externally-supplied map.
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

  // A completed assistant turn that invoked a shell tool: remember the
  // command text (keyed by tool_use_id) and give immediate feedback that
  // it's running. The final `command` event with a real exit code is
  // emitted later, from the matching `user` tool_result below.
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

  // The result of a shell tool call. `is_error` is the only reliable
  // success/failure signal in the captured shape (a numeric exit code isn't
  // consistently present), so exitCode here is 0/1 derived from is_error,
  // not a literal process exit status.
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
      return [{ type: 'error', message: errors || (typeof obj.result === 'string' && obj.result.trim()) || `Claude-Auftrag fehlgeschlagen (${obj.subtype ?? 'unbekannter Fehler'}).` }]
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
