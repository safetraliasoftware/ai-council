import type { ExecutionTask, TaskDependency, TaskEvent, TaskStatus } from './types'

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress'],
  in_progress: ['review', 'failed', 'escalated'],
  review: ['accepted', 'correcting', 'failed', 'escalated'],
  correcting: ['review', 'failed', 'escalated'],
  accepted: [],
  failed: [],
  escalated: [],
  invalidated: [],
  needs_revalidation: ['in_progress', 'accepted', 'invalidated', 'failed']
}

/**
 * Deterministic, side-effect-free domain layer for ExecutionTasks and their
 * dependencies. No LLM, UI, Electron or CodingExecutor knowledge - see the
 * plan at packages/task-graph for the full rationale.
 */
export class TaskGraph {
  private tasks = new Map<string, ExecutionTask>()
  private events: TaskEvent[] = []

  getTask(id: string): ExecutionTask | undefined {
    return this.tasks.get(id)
  }

  getAllTasks(): ExecutionTask[] {
    return [...this.tasks.values()]
  }

  getEvents(): TaskEvent[] {
    return [...this.events]
  }

  addTask(task: ExecutionTask): void {
    this.addTasks([task])
  }

  /**
   * Primary entry point for LLM-generated task graphs: builds the whole
   * batch against a temporary copy first (so forward references within the
   * same batch are allowed), validates all dependency references and checks
   * for cycles, and only then commits. On any failure the existing graph is
   * left completely unchanged.
   */
  addTasks(newTasks: ExecutionTask[]): void {
    const tempMap = new Map(this.tasks)
    for (const task of newTasks) {
      if (tempMap.has(task.id)) {
        throw new Error(`Task ${task.id} already exists`)
      }
      tempMap.set(task.id, task)
    }
    for (const task of newTasks) {
      for (const dep of task.dependencies) {
        if (!tempMap.has(dep.taskId)) {
          throw new Error(`Task ${task.id} depends on unknown task ${dep.taskId}`)
        }
      }
    }
    if (this.cyclesExistIn(tempMap)) {
      throw new Error('Adding these tasks would introduce a dependency cycle')
    }

    const now = Date.now()
    for (const task of newTasks) {
      this.tasks.set(task.id, task)
      this.events.push({ taskId: task.id, type: 'created', to: task.status, at: now })
    }
  }

  updateTask(id: string, patch: Partial<Omit<ExecutionTask, 'id' | 'status'>>): void {
    const task = this.requireTask(id)
    this.tasks.set(id, { ...task, ...patch })
  }

  addDependency(id: string, dep: TaskDependency): void {
    const task = this.requireTask(id)
    if (!this.tasks.has(dep.taskId)) {
      throw new Error(`Unknown dependency target: ${dep.taskId}`)
    }
    const updated: ExecutionTask = {
      ...task,
      dependencies: [...task.dependencies.filter((d) => d.taskId !== dep.taskId), dep]
    }
    const tempMap = new Map(this.tasks)
    tempMap.set(id, updated)
    if (this.cyclesExistIn(tempMap)) {
      throw new Error(`Adding dependency ${dep.taskId} -> ${id} would introduce a dependency cycle`)
    }
    this.tasks.set(id, updated)
    this.events.push({ taskId: id, type: 'dependency_added', reason: dep.taskId, at: Date.now() })
  }

  removeDependency(id: string, depTaskId: string): void {
    const task = this.requireTask(id)
    this.tasks.set(id, { ...task, dependencies: task.dependencies.filter((d) => d.taskId !== depTaskId) })
    this.events.push({ taskId: id, type: 'dependency_removed', reason: depTaskId, at: Date.now() })
  }

  detectCycles(): boolean {
    return this.cyclesExistIn(this.tasks)
  }

  topologicalOrder(): string[] {
    const inDegree = new Map<string, number>()
    const dependents = new Map<string, string[]>()
    for (const task of this.tasks.values()) {
      inDegree.set(task.id, task.dependencies.length)
      if (!dependents.has(task.id)) dependents.set(task.id, [])
    }
    for (const task of this.tasks.values()) {
      for (const dep of task.dependencies) {
        const list = dependents.get(dep.taskId) ?? []
        list.push(task.id)
        dependents.set(dep.taskId, list)
      }
    }

    const queue = [...inDegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id)
    const order: string[] = []
    while (queue.length > 0) {
      const id = queue.shift() as string
      order.push(id)
      for (const dependentId of dependents.get(id) ?? []) {
        const newDegree = (inDegree.get(dependentId) ?? 0) - 1
        inDegree.set(dependentId, newDegree)
        if (newDegree === 0) queue.push(dependentId)
      }
    }

    if (order.length !== this.tasks.size) {
      throw new Error('Cannot compute topological order: graph contains a cycle')
    }
    return order
  }

  getAncestors(id: string): string[] {
    const task = this.requireTask(id)
    const visited = new Set<string>()
    const stack = task.dependencies.map((d) => d.taskId)
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (visited.has(current)) continue
      visited.add(current)
      const currentTask = this.tasks.get(current)
      if (currentTask) stack.push(...currentTask.dependencies.map((d) => d.taskId))
    }
    return [...visited]
  }

  getDescendants(id: string): string[] {
    const visited = new Set<string>()
    const stack = this.getDirectDependents(id).map((t) => t.id)
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (visited.has(current)) continue
      visited.add(current)
      stack.push(...this.getDirectDependents(current).map((t) => t.id))
    }
    return [...visited]
  }

  /**
   * Single source of truth for "can this task start right now": pending,
   * every dependency accepted, and planned against the currently valid
   * specification version. task-graph has no notion of ProjectSpecification
   * itself, so the caller supplies the version to compare against.
   */
  canRun(id: string, currentSpecVersion: number): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    if (task.status !== 'pending') return false
    if (task.specVersion !== currentSpecVersion) return false
    return task.dependencies.every((dep) => this.tasks.get(dep.taskId)?.status === 'accepted')
  }

  getReadyTasks(currentSpecVersion: number): ExecutionTask[] {
    return this.getAllTasks().filter((t) => this.canRun(t.id, currentSpecVersion))
  }

  markInProgress(id: string): void {
    this.transition(id, 'in_progress')
  }

  markReview(id: string): void {
    this.transition(id, 'review')
  }

  markCorrecting(id: string): void {
    this.transition(id, 'correcting')
  }

  markAccepted(id: string): void {
    this.transition(id, 'accepted')
  }

  markFailed(id: string, reason: string): void {
    this.transition(id, 'failed', reason)
  }

  markEscalated(id: string, reason: string): void {
    this.transition(id, 'escalated', reason)
  }

  invalidateTask(id: string, reason: string): void {
    const task = this.requireTask(id)
    const from = task.status
    this.tasks.set(id, { ...task, status: 'invalidated' })
    this.events.push({ taskId: id, type: 'invalidated', from, to: 'invalidated', reason, at: Date.now() })
  }

  markNeedsRevalidation(id: string, reason: string): void {
    const task = this.requireTask(id)
    // A task can be reachable from an invalidated ancestor through more
    // than one path - e.g. a hard dependency on A and a soft dependency on
    // B, where both A and B get invalidated by the same (or a cascading)
    // call. invalidateDownstream() processes each root's cascade in turn,
    // so which path reaches this task LAST used to decide its final status
    // - a hard-then-soft order left it wrongly downgraded back to
    // 'needs_revalidation' after already being correctly hard-invalidated.
    // A hard invalidation is the stronger, more conclusive signal and must
    // never be downgraded by a weaker soft one arriving in a different
    // order - regardless of which root gets processed first. Caught in a
    // self-review.
    if (task.status === 'invalidated') return
    const from = task.status
    this.tasks.set(id, { ...task, status: 'needs_revalidation' })
    this.events.push({
      taskId: id,
      type: 'revalidation_needed',
      from,
      to: 'needs_revalidation',
      reason,
      at: Date.now()
    })
  }

  /**
   * Walks descendants of `id`, deciding invalidated vs. needs_revalidation
   * per dependency edge - never by graph position or a guess. A 'hard' edge
   * means the dependent's result is now definitely invalid, and the
   * cascade continues from there using that dependent's own edges. A
   * 'soft' edge only flags the direct dependent for re-checking and does
   * not cascade further, since it may still turn out to be fine.
   */
  invalidateDownstream(id: string, reason: string): void {
    for (const dependent of this.getDirectDependents(id)) {
      const edge = dependent.dependencies.find((d) => d.taskId === id)
      if (!edge) continue
      if (edge.impact === 'hard') {
        this.invalidateTask(dependent.id, reason)
        this.invalidateDownstream(dependent.id, reason)
      } else {
        this.markNeedsRevalidation(dependent.id, reason)
      }
    }
  }

  private transition(id: string, to: TaskStatus, reason?: string): void {
    const task = this.requireTask(id)
    const allowed = TRANSITIONS[task.status]
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition for ${id}: ${task.status} -> ${to}`)
    }
    const from = task.status
    this.tasks.set(id, { ...task, status: to })
    this.events.push({ taskId: id, type: 'status_changed', from, to, reason, at: Date.now() })
  }

  private requireTask(id: string): ExecutionTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`Unknown task: ${id}`)
    return task
  }

  private getDirectDependents(id: string): ExecutionTask[] {
    return this.getAllTasks().filter((t) => t.dependencies.some((d) => d.taskId === id))
  }

  private cyclesExistIn(tasksMap: Map<string, ExecutionTask>): boolean {
    const WHITE = 0
    const GRAY = 1
    const BLACK = 2
    const color = new Map<string, number>()
    for (const id of tasksMap.keys()) color.set(id, WHITE)

    const visit = (id: string): boolean => {
      color.set(id, GRAY)
      const task = tasksMap.get(id)
      if (task) {
        for (const dep of task.dependencies) {
          const depColor = color.get(dep.taskId)
          if (depColor === GRAY) return true
          if (depColor === WHITE && visit(dep.taskId)) return true
        }
      }
      color.set(id, BLACK)
      return false
    }

    for (const id of tasksMap.keys()) {
      if (color.get(id) === WHITE && visit(id)) return true
    }
    return false
  }
}
