import { describe, expect, it } from 'vitest'
import { TaskGraph } from '../task-graph'
import type { ExecutionTask, TaskDependency } from '../types'

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

/** Drives a task from 'pending' all the way to 'accepted' via the normal flow. */
function accept(graph: TaskGraph, id: string): void {
  graph.markInProgress(id)
  graph.markReview(id)
  graph.markAccepted(id)
}

describe('TaskGraph', () => {
  it('starts empty', () => {
    const graph = new TaskGraph()
    expect(graph.getAllTasks()).toEqual([])
    expect(graph.getReadyTasks(1)).toEqual([])
    expect(graph.topologicalOrder()).toEqual([])
    expect(graph.detectCycles()).toBe(false)
  })

  it('makes a single dependency-free task ready immediately', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-001'))
    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual(['TASK-001'])
  })

  it('handles a linear chain, unlocking each step only after the previous is accepted', () => {
    const graph = new TaskGraph()
    graph.addTasks([
      task('TASK-A'),
      task('TASK-B', { dependencies: [dep('TASK-A')] }),
      task('TASK-C', { dependencies: [dep('TASK-B')] })
    ])

    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual(['TASK-A'])
    accept(graph, 'TASK-A')
    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual(['TASK-B'])
    accept(graph, 'TASK-B')
    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual(['TASK-C'])
  })

  it('makes independent parallel tasks ready at the same time', () => {
    const graph = new TaskGraph()
    graph.addTasks([task('TASK-A'), task('TASK-B')])
    expect(new Set(graph.getReadyTasks(1).map((t) => t.id))).toEqual(new Set(['TASK-A', 'TASK-B']))
  })

  it('handles a diamond dependency, requiring both branches before the join task is ready', () => {
    const graph = new TaskGraph()
    graph.addTasks([
      task('TASK-ROOT'),
      task('TASK-LEFT', { dependencies: [dep('TASK-ROOT')] }),
      task('TASK-RIGHT', { dependencies: [dep('TASK-ROOT')] }),
      task('TASK-JOIN', { dependencies: [dep('TASK-LEFT'), dep('TASK-RIGHT')] })
    ])
    accept(graph, 'TASK-ROOT')
    expect(new Set(graph.getReadyTasks(1).map((t) => t.id))).toEqual(new Set(['TASK-LEFT', 'TASK-RIGHT']))
    accept(graph, 'TASK-LEFT')
    // TASK-RIGHT was already ready before LEFT was accepted and stays ready;
    // TASK-JOIN needs both branches, so it must not appear yet.
    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual(['TASK-RIGHT'])
    accept(graph, 'TASK-RIGHT')
    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual(['TASK-JOIN'])
  })

  it('rejects a batch that would introduce a cycle and leaves the graph unchanged', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-A'))
    expect(() =>
      graph.addTasks([
        task('TASK-B', { dependencies: [dep('TASK-A')] }),
        task('TASK-C', { dependencies: [dep('TASK-B')] })
      ])
    ).not.toThrow()

    expect(() => graph.addDependency('TASK-A', dep('TASK-C'))).toThrow(/cycle/)
    // graph must be unchanged: TASK-A still has no dependencies
    expect(graph.getTask('TASK-A')?.dependencies).toEqual([])
  })

  it('rejects a task referencing an unknown dependency', () => {
    const graph = new TaskGraph()
    expect(() => graph.addTask(task('TASK-A', { dependencies: [dep('TASK-GHOST')] }))).toThrow(/unknown task/)
  })

  it('rejects an entire addTasks batch if any entry is invalid, with no partial commit', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-A'))
    expect(() =>
      graph.addTasks([
        task('TASK-B', { dependencies: [dep('TASK-A')] }),
        task('TASK-C', { dependencies: [dep('TASK-GHOST')] })
      ])
    ).toThrow(/unknown task/)
    expect(graph.getTask('TASK-B')).toBeUndefined()
    expect(graph.getTask('TASK-C')).toBeUndefined()
  })

  it('allows forward references within a single addTasks batch', () => {
    const graph = new TaskGraph()
    // TASK-001 depends on TASK-007, which is only defined later in the same batch
    graph.addTasks([task('TASK-001', { dependencies: [dep('TASK-007')] }), task('TASK-007')])
    expect(graph.getTask('TASK-001')?.dependencies).toEqual([dep('TASK-007')])
  })

  it('blocks descendants of a failed task from ever becoming ready', () => {
    const graph = new TaskGraph()
    graph.addTasks([task('TASK-A'), task('TASK-B', { dependencies: [dep('TASK-A')] })])
    graph.markInProgress('TASK-A')
    graph.markFailed('TASK-A', 'build broke')
    expect(graph.getReadyTasks(1).map((t) => t.id)).toEqual([])
  })

  it('throws on an invalid status transition', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-A'))
    expect(() => graph.markAccepted('TASK-A')).toThrow(/Invalid transition/)
  })

  it('propagates invalidation along hard edges and cascades further, but stops at a soft edge', () => {
    const graph = new TaskGraph()
    graph.addTasks([
      task('TASK-010'),
      task('TASK-020', { dependencies: [dep('TASK-010', 'hard')] }),
      task('TASK-030', { dependencies: [dep('TASK-020', 'hard')] }),
      task('TASK-025', { dependencies: [dep('TASK-010', 'soft')] }),
      task('TASK-026', { dependencies: [dep('TASK-025', 'hard')] })
    ])
    for (const id of ['TASK-010', 'TASK-020', 'TASK-030', 'TASK-025', 'TASK-026']) accept(graph, id)

    graph.invalidateDownstream('TASK-010', 'schema changed')

    expect(graph.getTask('TASK-020')?.status).toBe('invalidated')
    expect(graph.getTask('TASK-030')?.status).toBe('invalidated') // cascaded through the hard edge from 020
    expect(graph.getTask('TASK-025')?.status).toBe('needs_revalidation')
    expect(graph.getTask('TASK-026')?.status).toBe('accepted') // cascade must NOT continue past a soft mark
  })

  it('REGRESSION (reihenfolgeabhängige Invalidierung bei gemischten Kanten): a task reachable via both a hard and a soft edge ends up invalidated regardless of processing order', () => {
    // A ChangeRequest can directly invalidate several root tasks in one
    // pass (see project-engine.ts's applyChangeRequest, which loops over
    // cr.affectedTaskIds calling invalidateTask+invalidateDownstream per
    // root). If a downstream task is reachable from one invalidated root
    // via a hard edge and from another via a soft edge, the hard edge is
    // the stronger, more conclusive signal and must win no matter which
    // root's cascade reaches it last - caught in a self-review.
    function buildFixture(): TaskGraph {
      const graph = new TaskGraph()
      graph.addTasks([task('A'), task('B'), task('X', { dependencies: [dep('A', 'hard'), dep('B', 'soft')] })])
      for (const id of ['A', 'B', 'X']) accept(graph, id)
      return graph
    }

    const softRootFirst = buildFixture()
    softRootFirst.invalidateTask('B', 'reason'); softRootFirst.invalidateDownstream('B', 'reason')
    softRootFirst.invalidateTask('A', 'reason'); softRootFirst.invalidateDownstream('A', 'reason')
    expect(softRootFirst.getTask('X')?.status).toBe('invalidated')

    const hardRootFirst = buildFixture()
    hardRootFirst.invalidateTask('A', 'reason'); hardRootFirst.invalidateDownstream('A', 'reason')
    hardRootFirst.invalidateTask('B', 'reason'); hardRootFirst.invalidateDownstream('B', 'reason')
    // Before the fix: processing the soft root (B) second overwrote X's
    // already-correct 'invalidated' status back down to
    // 'needs_revalidation', purely because of processing order.
    expect(hardRootFirst.getTask('X')?.status).toBe('invalidated')
  })

  it('lets a needs_revalidation task go straight back to accepted once re-checked', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-A'))
    accept(graph, 'TASK-A')
    graph.markNeedsRevalidation('TASK-A', 'upstream interface may have changed')
    expect(graph.getTask('TASK-A')?.status).toBe('needs_revalidation')
    graph.markAccepted('TASK-A')
    expect(graph.getTask('TASK-A')?.status).toBe('accepted')
  })

  it('excludes a task planned against a stale specification version from readiness', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-A', { specVersion: 2 }))
    expect(graph.canRun('TASK-A', 1)).toBe(false)
    expect(graph.canRun('TASK-A', 2)).toBe(true)
  })

  it('computes a topological order on a diamond and on a chain', () => {
    const graph = new TaskGraph()
    graph.addTasks([
      task('TASK-ROOT'),
      task('TASK-LEFT', { dependencies: [dep('TASK-ROOT')] }),
      task('TASK-RIGHT', { dependencies: [dep('TASK-ROOT')] }),
      task('TASK-JOIN', { dependencies: [dep('TASK-LEFT'), dep('TASK-RIGHT')] })
    ])
    const order = graph.topologicalOrder()
    const indexOf = (id: string): number => order.indexOf(id)
    expect(indexOf('TASK-ROOT')).toBeLessThan(indexOf('TASK-LEFT'))
    expect(indexOf('TASK-ROOT')).toBeLessThan(indexOf('TASK-RIGHT'))
    expect(indexOf('TASK-LEFT')).toBeLessThan(indexOf('TASK-JOIN'))
    expect(indexOf('TASK-RIGHT')).toBeLessThan(indexOf('TASK-JOIN'))
  })

  it('lets a new task be inserted into an already partially-executed graph and become ready immediately', () => {
    const graph = new TaskGraph()
    graph.addTask(task('TASK-A'))
    accept(graph, 'TASK-A')

    graph.addTask(task('TASK-NEW', { dependencies: [dep('TASK-A')] }))
    expect(graph.getReadyTasks(1).map((t) => t.id)).toContain('TASK-NEW')
  })

  it('computes ancestors and descendants', () => {
    const graph = new TaskGraph()
    graph.addTasks([
      task('TASK-ROOT'),
      task('TASK-MID', { dependencies: [dep('TASK-ROOT')] }),
      task('TASK-LEAF', { dependencies: [dep('TASK-MID')] })
    ])
    expect(new Set(graph.getAncestors('TASK-LEAF'))).toEqual(new Set(['TASK-ROOT', 'TASK-MID']))
    expect(new Set(graph.getDescendants('TASK-ROOT'))).toEqual(new Set(['TASK-MID', 'TASK-LEAF']))
  })
})
