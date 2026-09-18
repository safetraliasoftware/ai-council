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

const DEFAULT_BINARY = 'codex'

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
 * Runs the real, locally installed `codex` CLI (npm package `@openai/codex`)
 * as a child process, using `codex exec --json` for non-interactive,
 * structured output. Just like the Claude executor, this never touches
 * ChatGPT/OAuth credentials directly - `codex exec` reuses whatever session
 * the user already established by running `codex` and choosing "Sign in
 * with ChatGPT" themselves. We deliberately never set CODEX_API_KEY, since
 * that switches the CLI to pay-per-use API billing instead of the
 * ChatGPT plan - the opposite of what this executor is for. This mirrors
 * the official `@openai/codex-sdk` npm package's own auth model (it
 * requires CODEX_API_KEY) - we intentionally do NOT use that SDK, because
 * embedding it would mean paying per token instead of using the
 * already-authenticated CLI session.
 */
export class OpenAiCodexCliExecutor implements CodingExecutor {
  readonly id = 'openai-codex-cli'
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
    // the Codex CLI (unlike `claude auth status`, which has a confirmed,
    // documented exit-code contract). Reporting 'unknown' here is honest;
    // an actual auth failure still surfaces cleanly as an `error` event
    // from the first real task instead.
    return { installed: true, version, authStatus: 'unknown' }
  }

  capabilities(): CodingExecutorCapabilities {
    return { resumeSession: true, fileEditing: true, shellAccess: true }
  }

  startTask(spec: CodingTaskSpec, options?: StartTaskOptions): CodingExecutorHandle {
    // '-' + stdin, not the raw prompt as an argument - see spawn-process.ts's
    // SpawnOptions.stdin doc for why: codex's globally-installed .cmd shim
    // forwards args through a second cmd.exe layer that cross-spawn's
    // escaping doesn't fully account for, so a sufficiently complex prompt
    // can arrive corrupted. Caught live: a review-stage prompt reached
    // codex as if empty, and it asked back for the task instead of reading
    // the (correctly written) diff file it was pointed at.
    return this.run(['exec', ...sandboxArgs(spec), '--json', '-'], spec, options)
  }

  resumeSession(
    sessionId: string,
    spec: CodingTaskSpec,
    options?: StartTaskOptions
  ): CodingExecutorHandle {
    return this.run(
      ['exec', 'resume', sessionId, ...resumeSandboxArgs(spec), '--json', '-'],
      spec,
      options
    )
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

    // codex exec streams progress to stdout as JSONL when --json is passed
    // (progress otherwise goes to stderr in non-JSON mode, which we don't use).
    let agentText = ''
    let threadId: string | undefined
    let sawTerminal = false
    let inputTokens: number | undefined, outputTokens: number | undefined
    try {
      for await (const raw of parseNdjson(child.stdout)) {
        if (raw && typeof raw === 'object' && (raw as { type?: string }).type === 'turn.completed') {
          const usage = (raw as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage
          if (typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0) inputTokens = (inputTokens ?? 0) + usage.input_tokens
          if (typeof usage?.output_tokens === 'number' && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0) outputTokens = (outputTokens ?? 0) + usage.output_tokens
        }
        const mapped = mapEvent(raw, (text) => (agentText += text))
        for (const m of mapped) {
          if (m.event.type === 'done' || m.event.type === 'error') sawTerminal = true
          if (m.threadId) threadId = m.threadId
          yield m.event
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

    if (!sawTerminal) {
      setState(code === 0 ? 'done' : 'error')
      if (code !== 0) {
        yield {
          type: 'error',
          message: stderrTail.trim() || `codex beendete sich mit Exit-Code ${code}`,
          code: code === null ? undefined : String(code)
        }
      } else {
        yield { type: 'done', summary: agentText, sessionId: threadId, inputTokens, outputTokens }
      }
    } else {
      setState(code === 0 ? 'done' : 'error')
    }
  }
}

interface MappedEvent {
  event: CodingExecutorEvent
  threadId?: string
}

const CHANGE_KIND_MAP: Record<string, 'created' | 'modified' | 'deleted'> = {
  add: 'created',
  update: 'modified',
  delete: 'deleted'
}

type SandboxLevel = 'read-only' | 'workspace-write' | 'danger-full-access'

function sandboxLevel(spec: CodingTaskSpec): SandboxLevel | undefined {
  switch (spec.permissionTier) {
    case 'read-write':
      return 'workspace-write'
    case 'full':
      return 'danger-full-access'
    case 'read-only':
      return 'read-only'
    case undefined:
    default:
      return undefined
  }
}

/**
 * Translates the generic permission tier into Codex's --sandbox levels.
 * Leaving permissionTier unset means "don't pass --sandbox at all", which
 * inherits the user's configuration. Explicit read-only MUST override it:
 * a configured workspace-write default otherwise lets reviewers edit files.
 */
function sandboxArgs(spec: CodingTaskSpec): string[] {
  const level = sandboxLevel(spec)
  return level ? ['--sandbox', level] : []
}

/**
 * `codex exec resume` does NOT accept the top-level `--sandbox` flag that
 * `codex exec` does - live-verified: passing it produces "error: unexpected
 * argument '--sandbox' found ... Usage: codex exec resume <SESSION_ID>
 * [PROMPT]" and the process exits before running anything (caught live via
 * the app's own "Nachfassen"/follow-up feature on an existing session).
 * The `-c key=value` config override (documented on `codex exec resume
 * --help` itself) reaches the same setting instead - live-verified
 * end-to-end: starting a real session, then resuming it with
 * `-c sandbox_mode="workspace-write"` in place of `--sandbox
 * workspace-write` completes the turn successfully.
 */
function resumeSandboxArgs(spec: CodingTaskSpec): string[] {
  const level = sandboxLevel(spec)
  return level ? ['-c', `sandbox_mode="${level}"`] : []
}

/**
 * Maps codex exec's --json event stream (verified against the official
 * @openai/codex-sdk TypeScript source: sdk/typescript/src/{events,items}.ts)
 * onto CodingExecutorEvent. `onAgentText` accumulates the running answer so
 * the final `done` event carries a full summary, since Codex doesn't emit a
 * single top-level "final result" string the way Claude Code's `result`
 * message does.
 */
function mapEvent(raw: unknown, onAgentText: (text: string) => void): MappedEvent[] {
  if (typeof raw !== 'object' || raw === null) return []
  const obj = raw as Record<string, unknown>

  switch (obj.type) {
    case 'thread.started':
      return typeof obj.thread_id === 'string'
        ? [{ event: { type: 'status', message: 'thread.started' }, threadId: obj.thread_id }]
        : [{ event: { type: 'status', message: 'thread.started' } }]

    case 'turn.started':
      return [{ event: { type: 'status', message: 'turn.started' } }]

    case 'turn.failed': {
      const error = obj.error as Record<string, unknown> | undefined
      return [
        {
          event: {
            type: 'error',
            message: typeof error?.message === 'string' ? error.message : 'turn.failed'
          }
        }
      ]
    }

    case 'error':
      return [
        { event: { type: 'error', message: typeof obj.message === 'string' ? obj.message : 'Unbekannter Fehler' } }
      ]

    case 'item.completed': {
      const item = obj.item as Record<string, unknown> | undefined
      return item ? mapItem(item, onAgentText) : []
    }

    // item.started / item.updated / turn.completed carry no additional
    // information we act on yet (turn.completed's usage isn't in our
    // contract's event vocabulary); intentionally not mapped.
    default:
      return []
  }
}

function mapItem(item: Record<string, unknown>, onAgentText: (text: string) => void): MappedEvent[] {
  switch (item.type) {
    case 'agent_message': {
      const text = typeof item.text === 'string' ? item.text : ''
      onAgentText(text)
      return [{ event: { type: 'text', text } }]
    }

    case 'reasoning':
      return [{ event: { type: 'status', message: typeof item.text === 'string' ? item.text : 'reasoning' } }]

    case 'command_execution':
      return [
        {
          event: {
            type: 'command',
            command: typeof item.command === 'string' ? item.command : '',
            exitCode: typeof item.exit_code === 'number' ? item.exit_code : undefined
          }
        }
      ]

    case 'file_change': {
      // A single Codex patch item can touch several files at once - the
      // contract models one file_change event per path, so fan out here.
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : []
      return changes.map((change) => ({
        event: {
          type: 'file_change' as const,
          path: typeof change.path === 'string' ? change.path : '',
          changeType: CHANGE_KIND_MAP[change.kind as string] ?? 'modified'
        }
      }))
    }

    case 'web_search':
      return [
        { event: { type: 'status', message: `web_search: ${typeof item.query === 'string' ? item.query : ''}` } }
      ]

    case 'mcp_tool_call':
      return [
        {
          event: {
            type: 'status',
            message: `mcp_tool_call: ${item.server ?? '?'}/${item.tool ?? '?'}`
          }
        }
      ]

    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items.length : 0
      return [{ event: { type: 'status', message: `todo_list: ${items} Einträge` } }]
    }

    case 'error':
      // A non-fatal error surfaced as an item, distinct from the top-level
      // fatal `error`/`turn.failed` events, which map to our `error` type.
      return [
        { event: { type: 'warning', message: typeof item.message === 'string' ? item.message : 'error item' } }
      ]

    default:
      return []
  }
}
