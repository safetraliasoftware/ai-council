import { randomUUID } from 'node:crypto'
import type { AIProvider, CouncilRequest, GenerateOptions, ProviderId } from '@ai-council/shared'
import type { CouncilRunEvent, CouncilStage } from '../events'
import { mergeAsyncIterables } from '../merge-async-iterables'

const CANDIDATE_LABELS = ['Kandidat A', 'Kandidat B', 'Kandidat C', 'Kandidat D', 'Kandidat E']

interface RoundParticipant {
  provider: AIProvider
  label: string
  request: CouncilRequest
}

/**
 * Runs one round: every participant's request goes out concurrently, tagged
 * events are yielded as they arrive, and each participant's final text (or
 * undefined if it errored) is written into `resultsOut` once known - the
 * caller reads `resultsOut` only after the whole round generator is drained.
 */
async function* runRound(
  runId: string,
  stage: CouncilStage,
  participants: RoundParticipant[],
  resultsOut: Map<ProviderId, string>,
  options?: GenerateOptions
): AsyncGenerator<CouncilRunEvent> {
  const streams = participants.map(({ provider, label, request }) => {
    async function* tagged(): AsyncGenerator<CouncilRunEvent> {
      for await (const event of provider.generate(request, options)) {
        if (event.type === 'done') resultsOut.set(provider.id, event.result.text)
        yield { kind: 'provider_event', runId, providerId: provider.id, stage, label, event }
      }
    }
    return tagged()
  })
  yield* mergeAsyncIterables(streams)
}

function buildAnonymizedBlock(
  entries: { label: string; text: string }[],
  heading: string
): string {
  return entries.map((e) => `--- ${heading} von ${e.label} ---\n${e.text}`).join('\n\n')
}

export interface RunCouncilArgs {
  providers: AIProvider[]
  chairId: ProviderId
  request: CouncilRequest
  options?: GenerateOptions
}

/**
 * Council protocol v1 (Phase 3 MVP): independent round -> anonymized
 * critique round -> synthesis by a configurable chair. All orchestration
 * lives here, not in any host/UI layer.
 */
export function runCouncil(args: RunCouncilArgs): { runId: string; events: AsyncIterable<CouncilRunEvent> } {
  const runId = randomUUID()
  const { providers, chairId, request, options } = args

  async function* run(): AsyncGenerator<CouncilRunEvent> {
    const labels = new Map<ProviderId, string>(
      providers.map((p, i) => [p.id, CANDIDATE_LABELS[i] ?? `Kandidat ${i + 1}`])
    )
    const originalPrompt = request.messages.map((m) => m.content).join('\n\n')

    // Round 1: independent
    const independentResults = new Map<ProviderId, string>()
    yield* runRound(
      runId,
      'independent',
      providers.map((provider) => ({ provider, label: labels.get(provider.id)!, request })),
      independentResults,
      options
    )

    const answered = providers.filter((p) => independentResults.has(p.id))
    if (answered.length === 0) {
      yield { kind: 'run_done', runId }
      return
    }

    // Round 2: critique (anonymized, everyone critiques everyone else's answer)
    const critiqueResults = new Map<ProviderId, string>()
    const critiqueParticipants: RoundParticipant[] = answered.map((provider) => {
      const others = answered
        .filter((p) => p.id !== provider.id)
        .map((p) => ({ label: labels.get(p.id)!, text: independentResults.get(p.id)! }))
      const prompt = [
        `Ursprüngliche Aufgabe:\n${originalPrompt}`,
        buildAnonymizedBlock(others, 'Antwort'),
        'Deine Aufgabe: Kritisiere diese Antworten kritisch und konstruktiv. Prüfe auf fachliche Fehler, unbelegte Annahmen, fehlende Belege und Risiken. Kennzeichne jede bewertete Aussage mit einem der Tags FACT, ASSUMPTION, OPINION, RISK oder UNKNOWN.'
      ].join('\n\n')
      return { provider, label: labels.get(provider.id)!, request: { messages: [{ role: 'user', content: prompt }] } }
    })
    yield* runRound(runId, 'critique', critiqueParticipants, critiqueResults, options)

    // Round 3: synthesis by the chair
    const chair = answered.find((p) => p.id === chairId) ?? answered[0]
    const answerBlocks = answered.map((p) => ({ label: labels.get(p.id)!, text: independentResults.get(p.id)! }))
    const critiqueBlocks = answered
      .filter((p) => critiqueResults.has(p.id))
      .map((p) => ({ label: labels.get(p.id)!, text: critiqueResults.get(p.id)! }))
    const synthesisPrompt = [
      `Ursprüngliche Aufgabe:\n${originalPrompt}`,
      buildAnonymizedBlock(answerBlocks, 'Antwort'),
      buildAnonymizedBlock(critiqueBlocks, 'Kritik'),
      'Deine Aufgabe als Vorsitz: Fasse eine finale, konsolidierte Antwort zusammen. Berücksichtige berechtigte Kritikpunkte, löse Widersprüche zwischen den Kandidaten auf und benenne verbleibende Unsicherheiten explizit statt sie zu verschweigen.'
    ].join('\n\n')

    const synthesisResults = new Map<ProviderId, string>()
    yield* runRound(
      runId,
      'synthesis',
      [{ provider: chair, label: labels.get(chair.id)!, request: { messages: [{ role: 'user', content: synthesisPrompt }] } }],
      synthesisResults,
      options
    )

    yield { kind: 'run_done', runId }
  }

  return { runId, events: run() }
}
