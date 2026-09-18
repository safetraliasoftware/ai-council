import { describe, expect, it } from 'vitest'
import type { ExecutionTask, TaskDependency } from '@ai-council/task-graph'
import type { TaskGraphSnapshot } from '@ai-council/project-domain'
import { getReadyTaskIds, hydrateTaskGraph, withUpdatedTasks } from '../task-graph-runtime'

function task(id: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id,
    specVersion: 1,
    requirementIds: [],
    title: id,
    description: '',
    dependencies: [],
    scope: { allowedPaths: [] },
    status: 'pending',
    ...overrides
  }
}

function dep(taskId: string, impact: TaskDependency['impact'] = 'hard'): TaskDependency {
  return { taskId, impact }
}

function snapshotWith(tasks: ExecutionTask[]): TaskGraphSnapshot {
  return {
    projectId: 'proj-1',
    specVersion: 1,
    tasks,
    status: 'human_approved',
    chairId: 'anthropic',
    rawSynthesisText: '[]',
    createdAt: 1000,
    updatedAt: 1000
  }
}

describe('getReadyTaskIds', () => {
  it('a dependency-free task is ready immediately', () => {
    const snapshot = snapshotWith([task('A')])
    expect(getReadyTaskIds(snapshot)).toEqual(['A'])
  })

  it('DIAMOND: a join task only becomes ready once both branches are accepted', () => {
    const root = task('ROOT')
    const left = task('LEFT', { dependencies: [dep('ROOT')] })
    const right = task('RIGHT', { dependencies: [dep('ROOT')] })
    const join = task('JOIN', { dependencies: [dep('LEFT'), dep('RIGHT')] })
    const snapshot = snapshotWith([root, left, right, join])

    expect(getReadyTaskIds(snapshot)).toEqual(['ROOT'])

    // Accept ROOT and LEFT only - JOIN must still be blocked on RIGHT.
    const graph = hydrateTaskGraph(snapshot)
    graph.markInProgress('ROOT')
    graph.markReview('ROOT')
    graph.markAccepted('ROOT')
    graph.markInProgress('LEFT')
    graph.markReview('LEFT')
    graph.markAccepted('LEFT')
    const partial = withUpdatedTasks(snapshot, graph)

    const ready = getReadyTaskIds(partial)
    expect(ready).toContain('RIGHT')
    expect(ready).not.toContain('JOIN')
  })

  it('excludes a task whose specVersion no longer matches the snapshot', () => {
    const snapshot = snapshotWith([task('A', { specVersion: 2 })])
    expect(getReadyTaskIds(snapshot)).toEqual([])
  })
})

describe('withUpdatedTasks', () => {
  it('serializes status changes made on the hydrated graph back into a new snapshot', () => {
    const snapshot = snapshotWith([task('A')])
    const graph = hydrateTaskGraph(snapshot)
    graph.markInProgress('A')

    const updated = withUpdatedTasks(snapshot, graph)

    expect(updated.tasks.find((t) => t.id === 'A')?.status).toBe('in_progress')
    // Original snapshot object must not be mutated in place.
    expect(snapshot.tasks.find((t) => t.id === 'A')?.status).toBe('pending')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(snapshot.updatedAt)
  })

  it('preserves fields not related to task status (workingDirectory, projectId, etc.)', () => {
    const snapshot = { ...snapshotWith([task('A')]), workingDirectory: 'C:/repo' }
    const graph = hydrateTaskGraph(snapshot)
    const updated = withUpdatedTasks(snapshot, graph)

    expect(updated.workingDirectory).toBe('C:/repo')
    expect(updated.projectId).toBe('proj-1')
  })
})
