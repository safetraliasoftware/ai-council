import type { ProviderEvent, ProviderId } from '@ai-council/shared'

export type CouncilStage = 'independent' | 'critique' | 'synthesis'

export type CouncilRunEvent =
  | {
      kind: 'provider_event'
      runId: string
      providerId: ProviderId
      stepIndex?: number
      stage?: CouncilStage
      /** Stable per-run anonymized label ("Kandidat A", ...), set for council runs. */
      label?: string
      event: ProviderEvent
    }
  | { kind: 'run_done'; runId: string }

export interface CouncilRun {
  runId: string
  events: AsyncIterable<CouncilRunEvent>
}
