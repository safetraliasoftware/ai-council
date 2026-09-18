import type { CouncilRequest, GenerateOptions, ProviderCapabilities, ProviderEvent, ProviderId } from './contracts'

/**
 * Sits one abstraction level above AIProvider. council-core depends only on
 * this - never on AIProvider, never on a specific coding-agent contract.
 * Two adapters (built in @ai-council/council-participants, not here, to
 * avoid this zero-dependency package ever knowing about @ai-council/coding)
 * implement it: one wraps a real AIProvider (paid API), the other wraps a
 * CodingExecutor forced into a read-only advisory role (an already-paid-for
 * local CLI subscription standing in for a council seat).
 */
export type ParticipantBackend = 'api' | 'local_agent'

/**
 * A CouncilParticipant occupies exactly one ProviderId "seat" per run - this
 * is not a new restriction, council-core already keys every result/label/
 * chair lookup by ProviderId today (see runCouncil's chair fallback), so two
 * participants sharing an id in one run were always structurally ambiguous.
 * The id being exactly ProviderId (not a separate free-form id) makes that
 * explicit instead of adding a distinction that couldn't be honored anyway.
 */
export interface CouncilParticipant {
  readonly id: ProviderId
  readonly backend: ParticipantBackend
  capabilities(): ProviderCapabilities
  generate(request: CouncilRequest, options?: GenerateOptions): AsyncIterable<CouncilParticipantEvent>
}

/**
 * A strict superset of ProviderEvent (every ProviderEvent variant, unchanged,
 * plus three new ones only the local-agent adapter ever emits) - so a real
 * ProviderEvent value is always already a valid CouncilParticipantEvent and
 * the API adapter needs no event mapping, only a type-level rewrap.
 */
export type CouncilParticipantEvent =
  | ProviderEvent
  | { type: 'status'; message: string }
  | { type: 'warning'; message: string }
  /**
   * The local-agent adapter detected that the working directory changed
   * during a call that was supposed to be read-only. Additive - yielded
   * after `done`/`error`, never instead of it. Callers must never act on
   * a CouncilParticipant run's output by writing/merging anything; this
   * event exists purely so that invariant has a loud, visible signal
   * instead of relying on it silently remaining true forever.
   */
  | { type: 'policy_violation'; message: string }
