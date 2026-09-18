/** Keeps background consumers alive until they have cancelled and persisted their results. */
export class RunLifecycle {
  private stopping = false
  private active = new Map<symbol, { cancel: () => void; done: Promise<unknown> }>()

  assertRunning(): void {
    if (this.stopping) throw new Error('Das Programm wird beendet. Neue Aufträge sind gesperrt.')
  }

  track<T>(cancel: () => void, work: () => Promise<T>): Promise<T> {
    this.assertRunning()
    const id = Symbol()
    // Start on the next microtask so shutdown always sees the registration first.
    const done = Promise.resolve().then(work).finally(() => this.active.delete(id))
    this.active.set(id, { cancel, done })
    return done
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    const running = [...this.active.values()]
    const cancellation = running.map(run => {
      try { run.cancel(); return undefined } catch (error) { return error }
    })
    const results = await Promise.allSettled(running.map(run => run.done))
    const failures = [...cancellation.filter(Boolean), ...results.flatMap(r => r.status === 'rejected' ? [r.reason] : [])]
    if (failures.length) throw new AggregateError(failures, 'Nicht alle laufenden Aufträge konnten sicher abgeschlossen werden.')
  }
}

export const applicationRuns = new RunLifecycle()
