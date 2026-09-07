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
      events: this.streamProcess(taskId, args, spec.workingDirectory, controller, (state) => {
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
    controller: AbortController,
    setState: (state: CodingTaskState) => void
  ): AsyncGenerator<CodingExecutorEvent> {
    yield { type: 'start', taskId }

    const { child, exitCode } = spawnProcess(this.binary, args, { cwd, signal: controller.signal })
    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000)
    })

    let sawResult = false
    try {
      for await (const raw of parseNdjson(child.stdout)) {
        for (const event of mapEvent(raw)) {
          if (event.type === 'done') sawResult = true
          yield event
        }
      }
    } catch (err) {
      setState('error')
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }

    const code = await exitCode

    if (controller.signal.aborted) {
      setState('aborted')
      return
    }

    if (!sawResult) {
      setState(code === 0 ? 'done' : 'error')
      if (code !== 0) {
        yield {
          type: 'error',
          message: stderrTail.trim() || `claude beendete sich mit Exit-Code ${code}`,
          code: code === null ? undefined : String(code)
        }
      } else {
        yield { type: 'done', summary: '' }
      }
    } else {
      setState(code === 0 ? 'done' : 'error')
    }
  }
}

const PERMISSION_TIER_TOOLS: Record<NonNullable<CodingTaskSpec['permissionTier']>, string[]> = {
  'read-only': ['Read', 'Glob', 'Grep'],
  'read-write': ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
  full: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
}

function buildArgs(spec: CodingTaskSpec): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
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
 * and the terminal `result` message (including its `permission_denials`
 * array) are all verified against a real captured run - see the code
 * review discussion this was built from. Other tool types (Edit/Write/
 * Read/etc.) are intentionally not mapped yet - their exact shape wasn't
 * captured in that run, and guessing would risk misreporting what Claude
 * actually did.
 */
function mapEvent(raw: unknown): CodingExecutorEvent[] {
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

  // A completed assistant turn that invoked a shell tool. We only surface
  // the command itself here (verified field: message.content[].input.command)
  // - the corresponding `user` tool_result message that reports success/
  // failure/output isn't mapped yet, so no exitCode is attached.
  if (obj.type === 'assistant' && typeof obj.message === 'object' && obj.message !== null) {
    const message = obj.message as Record<string, unknown>
    const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
    const events: CodingExecutorEvent[] = []
    for (const block of content) {
      if (
        block.type === 'tool_use' &&
        typeof block.name === 'string' &&
        SHELL_TOOL_NAMES.has(block.name) &&
        typeof block.input === 'object' &&
        block.input !== null
      ) {
        const input = block.input as Record<string, unknown>
        if (typeof input.command === 'string') {
          events.push({ type: 'command', command: input.command })
        }
      }
    }
    return events
  }

  if (obj.type === 'result') {
    const events: CodingExecutorEvent[] = []
    const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : []
    if (denials.length > 0) {
      const names = denials
        .map((d) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>).tool_name : undefined))
        .filter((n): n is string => typeof n === 'string')
      events.push({
        type: 'warning',
        message: `${denials.length} Werkzeug-Aufruf(e) wurden verweigert (keine Freigabe im aktuellen Rechte-Level): ${names.join(', ')}`
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
