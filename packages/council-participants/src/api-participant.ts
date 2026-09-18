import type { AIProvider, CouncilParticipant } from '@ai-council/shared'

/**
 * Thin wrapper - CouncilParticipantEvent is a strict superset of
 * ProviderEvent (see packages/shared/src/council-participant.ts), so a real
 * AIProvider's event stream is already a valid CouncilParticipant event
 * stream. No runtime mapping needed, just re-exposing it through the wider
 * contract.
 */
export function toApiCouncilParticipant(provider: AIProvider): CouncilParticipant {
  return {
    id: provider.id,
    backend: 'api',
    capabilities: () => provider.capabilities(),
    generate: (request, options) => provider.generate(request, options)
  }
}
