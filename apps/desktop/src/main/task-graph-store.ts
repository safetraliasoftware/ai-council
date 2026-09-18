import { app } from 'electron'
import { join } from 'node:path'
import { assertSafeId, readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'
import type { TaskGraphSnapshot } from '@ai-council/project-domain'

/**
 * Flat per-project JSON file, read-modify-write - simpler than
 * project-event-log.ts's append-only log on purpose (see task-graph-format.ts's
 * doc comment: a task graph is replaced wholesale, no version history yet).
 */

function projectDir(projectId: string): string {
  assertSafeId(projectId, 'Projekt-ID')
  return join(app.getPath('userData'), 'projects', projectId)
}

function storePath(projectId: string): string {
  return join(projectDir(projectId), 'task-graph.json')
}

export function readTaskGraph(projectId: string): TaskGraphSnapshot | undefined {
  const snapshot = readJsonFileSafe<TaskGraphSnapshot | undefined>(storePath(projectId), undefined)
  if (snapshot) {
    // replacedByTaskId was a single string before it became a list (to
    // support splitting one invalidated task into several replacements) -
    // a graph saved by an older version of this app still has the old
    // shape on disk, which the current type just claims isn't possible.
    // Without this, the renderer's `.join()` on it throws. Caught in a
    // self-review.
    for (const task of snapshot.tasks) {
      const legacy = task.replacedByTaskId as unknown
      if (typeof legacy === 'string') task.replacedByTaskId = [legacy]
    }
  }
  return snapshot
}

export function writeTaskGraph(projectId: string, snapshot: TaskGraphSnapshot): void {
  writeJsonFileAtomic(storePath(projectId), snapshot)
}
