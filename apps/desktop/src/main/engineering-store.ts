import type { ProjectExecution, TaskGraphSnapshot } from '@ai-council/project-domain'
import { appendEvent, readProjectEvents } from './project-event-log'
import { readTaskGraph, writeTaskGraph } from './task-graph-store'

export function loadExecution(projectId: string): ProjectExecution | undefined {
  const events = readProjectEvents(projectId)
  const event = events.filter(e => e.type === 'ExecutionStateChanged').at(-1)
  if (!event) return undefined
  const payload = event.payload as { state: ProjectExecution; graph: TaskGraphSnapshot }
  for (const extra of events.filter(e => e.sequence > event.sequence && e.type === 'ExecutionAgentEvent')) {
    const data = extra.payload as { attemptId: string; event: unknown }
    payload.state.attempts.find(a => a.id === data.attemptId)?.events.push(data.event)
  }
  // The event is authoritative if a crash happened between append and snapshot write.
  const current = readTaskGraph(projectId)
  if (!current) writeTaskGraph(projectId, payload.graph)
  else if (current.specVersion === payload.graph.specVersion &&
      JSON.stringify(current.tasks.map(t => t.id)) === JSON.stringify(payload.graph.tasks.map(t => t.id))) {
    // Preserve newer human approval/rejection and configuration; replay only execution projection.
    writeTaskGraph(projectId, { ...current, tasks: payload.graph.tasks })
  }
  return structuredClone(payload.state)
}

export async function saveExecution(state: ProjectExecution, graph: TaskGraphSnapshot, reason: string): Promise<void> {
  const projection = structuredClone(graph)
  for (const task of projection.tasks) {
    // 'invalidated'/'needs_revalidation' are only ever set by ProjectEngine
    // explicitly calling the real TaskGraph mutators (see applyChangeRequest)
    // - this generic attempt-status projection has no concept of either and
    // would otherwise silently revert them on the very next unrelated save.
    if (task.status === 'invalidated' || task.status === 'needs_revalidation') continue
    const attempt = [...state.attempts].reverse().find(a => a.taskId === task.id)
    if (!attempt) continue
    task.status = attempt.status === 'accepted' ? 'accepted'
      : attempt.status === 'running' || attempt.status === 'awaiting_permission' || attempt.status === 'awaiting_install' ? 'in_progress'
      : attempt.status === 'review' ? 'review' : attempt.status === 'escalated' ? 'escalated' : 'failed'
  }
  await appendEvent(state.projectId, { projectId: state.projectId, type: 'ExecutionStateChanged', timestamp: Date.now(),
    payload: { reason, state: structuredClone(state), graph: projection } })
  writeTaskGraph(state.projectId, projection)
}
