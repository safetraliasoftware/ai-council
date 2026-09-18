import { TaskGraph } from '@ai-council/task-graph'
import type { TaskGraphSnapshot } from '@ai-council/project-domain'

/**
 * Rehydrates the pure, in-memory TaskGraph engine from a persisted
 * TaskGraphSnapshot for one call, applies whatever the caller needs, then
 * serializes the result back. Deliberately stateless (no in-memory cache
 * across calls) - task-graph-ipc.ts's approve/reject handlers already write
 * TaskGraphSnapshot directly, so a cache here would risk going stale
 * relative to those writes. Reading fresh from disk every call sidesteps
 * that whole class of bug.
 */
export function hydrateTaskGraph(snapshot: TaskGraphSnapshot): TaskGraph {
  const graph = new TaskGraph()
  graph.addTasks(snapshot.tasks)
  return graph
}

/**
 * The set of task ids currently ready to run - the single source of truth
 * for "is this task startable", so the renderer never has to duplicate
 * TaskGraph.canRun()'s own logic (that duplication is exactly the kind of
 * drift that caused the earlier hard/soft dependency confusion).
 */
export function getReadyTaskIds(snapshot: TaskGraphSnapshot): string[] {
  return hydrateTaskGraph(snapshot)
    .getReadyTasks(snapshot.specVersion)
    .map((t) => t.id)
}

/** Serializes a TaskGraph's current task state back into a fresh snapshot, ready for writeTaskGraph(). */
export function withUpdatedTasks(snapshot: TaskGraphSnapshot, graph: TaskGraph): TaskGraphSnapshot {
  return { ...snapshot, tasks: graph.getAllTasks(), updatedAt: Date.now() }
}
