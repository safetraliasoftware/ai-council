// 'ready' is deliberately NOT a stored status - readiness is always derived
// (see getReadyTasks/canRun), never set directly, so it can never go stale
// after an invalidation.
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'review'
  | 'correcting'
  | 'accepted'
  | 'failed'
  | 'escalated'
  | 'invalidated'
  | 'needs_revalidation'

export interface TaskScope {
  allowedPaths: string[]
  suspectedFiles?: string[]
  readOnlyContext?: string[]
}

export interface TaskDependency {
  taskId: string
  /** 'hard': a change to taskId invalidates this task. 'soft': only needs_revalidation. */
  impact: 'hard' | 'soft'
}

export interface ExecutionTask {
  id: string
  specVersion: number
  requirementIds: string[]
  title: string
  description: string
  dependencies: TaskDependency[]
  scope: TaskScope
  status: TaskStatus
  /** Set on a hard-invalidated task once replacement task(s) have been created for it (ChangeRequest flow). 'invalidated' is terminal - this is how the UI/dependents find what to look at instead. A list, not a single id: the Council's replacement prompt may legitimately split one invalidated task into several - a single field would silently drop all but the last. */
  replacedByTaskId?: string[]
}

export type TaskEventType =
  | 'created'
  | 'status_changed'
  | 'invalidated'
  | 'revalidation_needed'
  | 'dependency_added'
  | 'dependency_removed'

export interface TaskEvent {
  taskId: string
  type: TaskEventType
  from?: TaskStatus
  to?: TaskStatus
  reason?: string
  at: number
}
