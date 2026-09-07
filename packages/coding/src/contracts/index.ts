/**
 * CodingExecutor is a deliberately separate contract from AIProvider
 * (packages/shared). AIProvider answers one model request. A CodingExecutor
 * is an agentic runtime with its own filesystem/shell access, sessions, and
 * permission model - forcing it through the AIProvider shape would either
 * cripple it or force AIProvider to grow filesystem/session concepts it
 * shouldn't have. council-core and the renderer must only ever depend on
 * this file, never on a specific executor's implementation types.
 */

export type CodingExecutorEvent =
  | { type: 'start'; taskId: string }
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'file_change'; path: string; changeType: 'created' | 'modified' | 'deleted' }
  | { type: 'command'; command: string; exitCode?: number }
  | { type: 'test_result'; passed: boolean; summary: string }
  | { type: 'warning'; message: string }
  | { type: 'done'; summary: string; sessionId?: string; costUsd?: number }
  | { type: 'error'; message: string; code?: string }

export type ExecutorAuthStatus = 'authenticated' | 'unauthenticated' | 'unknown'

export interface ExecutorAvailability {
  installed: boolean
  version?: string
  authStatus: ExecutorAuthStatus
}

export interface CodingExecutorCapabilities {
  /** Can a previous session be continued via resumeSession()? */
  resumeSession: boolean
  fileEditing: boolean
  shellAccess: boolean
}

export type CodingTaskState = 'running' | 'done' | 'error' | 'aborted'

export interface CodingTaskStatus {
  taskId: string
  state: CodingTaskState
}

/**
 * Executor-agnostic permission tier, chosen explicitly by the caller (never
 * defaulted by an executor) - each executor translates it into its own
 * mechanism: Claude Code -> --allowedTools, Codex -> --sandbox. Leaving this
 * unset means "don't grant anything beyond the CLI's own out-of-the-box
 * behavior" (Claude Code: fully manual approval; Codex: read-only sandbox).
 */
export type PermissionTier = 'read-only' | 'read-write' | 'full'

export interface CodingTaskSpec {
  prompt: string
  /** Absolute path. The executor must never write outside this directory tree. */
  workingDirectory: string
  /** read-only: safe exploration only. read-write: also file edits. full: also shell/commands. */
  permissionTier?: PermissionTier
  /** Tool names the executor may use without prompting (Claude-specific; advanced override). */
  allowedTools?: string[]
}

export interface StartTaskOptions {
  signal?: AbortSignal
}

export interface CodingExecutorHandle {
  taskId: string
  events: AsyncIterable<CodingExecutorEvent>
}

export interface CodingExecutor {
  readonly id: string

  /** Checks whether the underlying tool is installed and authenticated, without starting a task. */
  detect(): Promise<ExecutorAvailability>

  capabilities(): CodingExecutorCapabilities

  startTask(spec: CodingTaskSpec, options?: StartTaskOptions): CodingExecutorHandle

  /** Re-subscribe to a task's event stream by id (same iterable startTask() returned). */
  streamEvents(taskId: string): AsyncIterable<CodingExecutorEvent> | undefined

  getStatus(taskId: string): CodingTaskStatus | undefined

  abort(taskId: string): void

  /** Only meaningful when capabilities().resumeSession is true. */
  resumeSession?(
    sessionId: string,
    spec: CodingTaskSpec,
    options?: StartTaskOptions
  ): CodingExecutorHandle
}
