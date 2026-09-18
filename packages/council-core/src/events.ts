import type { CouncilParticipantEvent, ParticipantBackend, ProviderId } from '@ai-council/shared'
import type { CouncilCallUsage } from './run-usage'

export type CouncilStage = 'independent' | 'critique' | 'revision' | 'synthesis'

export type CouncilRunEvent =
  | {
      kind: 'provider_event'
      runId: string
      providerId: ProviderId
      /** Which kind of participant produced this event - additive, not yet read by any renderer. */
      backend: ParticipantBackend
      stepIndex?: number
      stage?: CouncilStage
      /** Stable per-run anonymized label ("Kandidat A", ...), set for council runs. */
      label?: string
      event: CouncilParticipantEvent
    }
  | { kind: 'run_done'; runId: string; usage?: CouncilCallUsage[] }

export interface CouncilRun {
  runId: string
  events: AsyncIterable<CouncilRunEvent>
  /** Live snapshots, including failed calls when the event iterator throws. */
  usage?: CouncilCallUsage[]
  observeUsage?: (listener: () => void) => void
}
