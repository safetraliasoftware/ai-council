import { RunUsageTracker } from '../run-usage'
import { randomUUID } from 'node:crypto'
import type { CouncilParticipant, CouncilParticipantEvent, CouncilRequest, GenerateOptions, ProviderId } from '@ai-council/shared'

/** Copy original inputFiles onto a derived round so later stages still see the attachments. */
function withInputFiles(original: CouncilRequest, derived: CouncilRequest): CouncilRequest {
  return original.inputFiles?.length ? { ...derived, inputFiles: original.inputFiles } : derived
}
import type { CouncilRun, CouncilRunEvent, CouncilStage } from '../events'
import { mergeAsyncIterables } from '../merge-async-iterables'
import { assertUniqueParticipantIds } from '../assert-unique-ids'

const CANDIDATE_LABELS = ['Kandidat A', 'Kandidat B', 'Kandidat C', 'Kandidat D', 'Kandidat E']

interface RoundParticipant {
  provider: CouncilParticipant
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
  options: GenerateOptions | undefined,
  usage: RunUsageTracker
): AsyncGenerator<CouncilRunEvent> {
  const streams = participants.map(({ provider, label, request }) => {
    async function* tagged(): AsyncGenerator<CouncilRunEvent> {
      let done: Extract<CouncilParticipantEvent, { type: 'done' }> | undefined
      let invalid = false
      for await (const event of usage.generate(provider, request, options, stage)) {
        if (event.type === 'error' || event.type === 'policy_violation') invalid = true
        if (event.type === 'done') { done = event; continue }
        yield { kind: 'provider_event', runId, providerId: provider.id, backend: provider.backend, stage, label, event }
      }
      if (done && !invalid && !options?.signal?.aborted) {
        resultsOut.set(provider.id, done.result.text)
        yield { kind: 'provider_event', runId, providerId: provider.id, backend: provider.backend, stage, label, event: done }
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
  deliberation?: 'compact' | 'full'
  providers: CouncilParticipant[]
  chairId: ProviderId
  request: CouncilRequest
  options?: GenerateOptions
}

/**
 * Council protocol v1 (Phase 3 MVP): independent round -> anonymized
 * critique round -> synthesis by a configurable chair. All orchestration
 * lives here, not in any host/UI layer.
 */
export function runCouncil(args: RunCouncilArgs): CouncilRun {
  const runId = randomUUID()
  const usage = new RunUsageTracker()
  const { providers, chairId, request, options } = args
  assertUniqueParticipantIds(providers)

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
      options, usage
    )

    const answered = providers.filter((p) => independentResults.has(p.id))
    if (answered.length === 0) {
      yield { kind: 'run_done', runId, usage: usage.calls }
      return
    }

    if (args.deliberation === 'compact') {
      if (options?.signal?.aborted) { yield { kind: 'run_done', runId, usage: usage.calls }; return }
      const chair = answered.find(p => p.id === chairId) ?? answered[0]
      const prompt = [
        `Ursprüngliche Aufgabe:\n${originalPrompt}`,
        buildAnonymizedBlock(answered.map(p => ({ label: labels.get(p.id)!, text: independentResults.get(p.id)! })), 'Entwurf'),
        'Prüfe die Entwürfe auf konkrete Fehler und Widersprüche und konsolidiere sie. Wähle für reversible Implementierungsdetails vernünftige Standards und dokumentiere sie kurz. Frage nur nach fehlenden Entscheidungen, die Ziel, Kosten, Sicherheit oder verbindliche Anforderungen wesentlich verändern. Halte das ursprüngliche Ausgabeformat ein. Tatsächliche ungelöste Blocker dürfen nicht überstimmt werden.'
      ].join('\n\n')
      yield* runRound(runId, 'synthesis', [{ provider: chair, label: labels.get(chair.id)!,
        request: withInputFiles(request, { systemInstructions: request.systemInstructions, messages: [{ role: 'user', content: prompt }] }) }], new Map(), options, usage)
      yield { kind: 'run_done', runId, usage: usage.calls }
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
        others.length ? buildAnonymizedBlock(others, 'Antwort') : `Es gibt nur einen Teilnehmer. Prüfe deshalb die Annahmen und Gegenpositionen deines eigenen Entwurfs:\n${independentResults.get(provider.id)}`,
        'Deine Aufgabe: Kritisiere diese Antworten kritisch und konstruktiv. Prüfe auf fachliche Fehler, unbelegte Annahmen, fehlende Belege und Risiken. Kennzeichne jede bewertete Aussage mit einem der Tags FACT, ASSUMPTION, OPINION, RISK oder UNKNOWN.'
      ].join('\n\n')
      return { provider, label: labels.get(provider.id)!, request: withInputFiles(request, { messages: [{ role: 'user', content: prompt }] }) }
    })
    yield* runRound(runId, 'critique', critiqueParticipants, critiqueResults, options, usage)

    // Round 3: each remaining participant revises its own proposal.
    const revisions = new Map<ProviderId, string>()
    const eligible = answered.filter(p => critiqueResults.has(p.id))
    yield* runRound(runId, 'revision', eligible.map(provider => ({
      provider, label: labels.get(provider.id)!, request: withInputFiles(request, { systemInstructions: request.systemInstructions, messages: [{ role: 'user', content: [
        `Ursprüngliche Aufgabe:\n${originalPrompt}`,
        `Dein Entwurf:\n${independentResults.get(provider.id)}`,
        buildAnonymizedBlock(eligible.map(p => ({ label: labels.get(p.id)!, text: critiqueResults.get(p.id)! })), 'Kritik'),
        'Überarbeite deinen Entwurf anhand der Kritik. Benenne verbleibende blockierende Einwände, Risiken und unbelegte Annahmen ausdrücklich.'
      ].join('\n\n') }] })
    })), revisions, options, usage)
    const revised = eligible.filter(p => revisions.has(p.id))
    if (!revised.length || options?.signal?.aborted) { yield { kind: 'run_done', runId, usage: usage.calls }; return }
    // Round 4: synthesis by the configured chair (or a surviving participant).
    const chair = revised.find((p) => p.id === chairId) ?? revised[0]
    const answerBlocks = revised.map((p) => ({ label: labels.get(p.id)!, text: revisions.get(p.id)! }))
    const critiqueBlocks = answered
      .filter((p) => critiqueResults.has(p.id))
      .map((p) => ({ label: labels.get(p.id)!, text: critiqueResults.get(p.id)! }))
    const synthesisPrompt = [
      `Ursprüngliche Aufgabe:\n${originalPrompt}`,
      buildAnonymizedBlock(answerBlocks, 'Antwort'),
      buildAnonymizedBlock(critiqueBlocks, 'Kritik'),
      'Halte das geforderte Ausgabeformat der ursprünglichen Aufgabe ein. Ein einzelner begründeter blockierender Einwand darf nicht durch mehrere Zustimmungen überstimmt werden. Ungeklärte Blocker bleiben ausdrücklich offen.',
      'Deine Aufgabe als Vorsitz: Fasse eine finale, konsolidierte Antwort zusammen. Berücksichtige berechtigte Kritikpunkte, löse Widersprüche zwischen den Kandidaten auf und benenne verbleibende Unsicherheiten explizit statt sie zu verschweigen.'
    ].join('\n\n')

    const synthesisResults = new Map<ProviderId, string>()
    yield* runRound(
      runId,
      'synthesis',
      [{ provider: chair, label: labels.get(chair.id)!, request: withInputFiles(request, { messages: [{ role: 'user', content: synthesisPrompt }] }) }],
      synthesisResults,
      options, usage
    )

    yield { kind: 'run_done', runId, usage: usage.calls }
  }

  return { runId, events: run(), usage: usage.calls, observeUsage: listener => { usage.onChange = listener } }
}
