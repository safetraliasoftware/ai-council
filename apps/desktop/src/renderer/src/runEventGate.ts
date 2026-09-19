import type { CouncilRunEvent } from '@ai-council/council-core'

/**
 * Bridges the window between "IPC invoke has started the run" and "the
 * renderer has stored the runId". Events that arrive in that gap used to
 * be dropped (including run_done), which left Compare/Team/Council stuck
 * on "Läuft…". Buffer them until commit(runId), then replay matches.
 */
export function createRunEventGate(): {
  begin: () => void
  fail: () => void
  commit: (runId: string) => CouncilRunEvent[]
  take: (event: CouncilRunEvent) => CouncilRunEvent | undefined
  readonly id: string
} {
  let currentId = ''
  let waiting = false
  const pending: CouncilRunEvent[] = []

  return {
    begin(): void {
      waiting = true
      currentId = ''
      pending.length = 0
    },
    fail(): void {
      waiting = false
      currentId = ''
      pending.length = 0
    },
    commit(runId: string): CouncilRunEvent[] {
      currentId = runId
      waiting = false
      const flushed = pending.filter((event) => event.runId === runId)
      pending.length = 0
      return flushed
    },
    take(event: CouncilRunEvent): CouncilRunEvent | undefined {
      if (waiting) {
        pending.push(event)
        return undefined
      }
      return event.runId === currentId ? event : undefined
    },
    get id(): string {
      return currentId
    }
  }
}
