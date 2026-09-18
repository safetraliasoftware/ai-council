import type { CouncilParticipant } from '@ai-council/shared'

/**
 * Every result/label/chair lookup across compare/team/council is keyed by
 * participant.id (a ProviderId) - a duplicate id in one run would silently
 * overwrite one participant's result with another's and could pick the
 * wrong chair, with no error to explain why. Structurally always possible
 * (nothing stopped two same-id AIProviders before either), just never hit
 * in practice - this turns that silent-wrong-answer failure mode into a
 * loud one.
 */
export function assertUniqueParticipantIds(participants: CouncilParticipant[]): void {
  const seen = new Set<string>()
  for (const p of participants) {
    if (seen.has(p.id)) {
      throw new Error(`Doppelter Council-Teilnehmer: "${p.id}" ist mehrfach in diesem Lauf angegeben.`)
    }
    seen.add(p.id)
  }
}
