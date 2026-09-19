import { describe, expect, it } from 'vitest'
import type { CouncilParticipant, CouncilParticipantEvent, CouncilRequest, ProviderId } from '@ai-council/shared'
import { runCouncil } from '../orchestrator/council'

function makeMockProvider(id: ProviderId): CouncilParticipant {
  return {
    id,
    backend: 'api',
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(request: CouncilRequest): AsyncIterable<CouncilParticipantEvent> {
      const reply = `${id}-reply-to(${request.messages[0].content.length}chars)`
      yield { type: 'start', runId: 'mock' }
      yield { type: 'text_delta', text: reply }
      yield { type: 'done', result: { text: reply } }
    }
  }
}

describe('runCouncil', () => {
  it('compact planning uses three independent drafts and one synthesis instead of ten calls', async () => {
    const events = []
    const run = runCouncil({
      deliberation: 'compact',
      providers: ['anthropic', 'openai', 'gemini'].map(id => makeMockProvider(id as ProviderId)),
      chairId: 'openai', request: { messages: [{ role: 'user', content: 'Build a calculator' }] }
    })
    for await (const event of run.events) events.push(event)
    const completions = events.filter(e => e.kind === 'provider_event' && e.event.type === 'done')
    expect(completions).toHaveLength(4)
    expect(completions.map(e => e.kind === 'provider_event' && e.stage)).toEqual(['independent', 'independent', 'independent', 'synthesis'])
    expect(completions.at(-1)).toMatchObject({ providerId: 'openai' })
    expect(events.at(-1)).toMatchObject({ kind: 'run_done' })
  })

  it('does not synthesize compact drafts after cancellation', async () => {
    const controller = new AbortController()
    const provider = makeMockProvider('anthropic')
    const generate = provider.generate.bind(provider)
    provider.generate = async function* (request, options) {
      yield* generate(request, options)
      controller.abort()
    }
    const events = []
    const run = runCouncil({ deliberation: 'compact', providers: [provider], chairId: 'anthropic',
      request: { messages: [{ role: 'user', content: 'calculator' }] }, options: { signal: controller.signal } })
    for await (const event of run.events) events.push(event)
    expect(events.some(e => e.kind === 'provider_event' && e.stage === 'synthesis')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'run_done' })
  })

  it('runs independent -> critique -> revision -> synthesis in that order, chair only synthesizes', async () => {
    const claude = makeMockProvider('anthropic')
    const openai = makeMockProvider('openai')
    const gemini = makeMockProvider('gemini')

    const run = runCouncil({
      providers: [claude, openai, gemini],
      chairId: 'anthropic',
      request: { messages: [{ role: 'user', content: 'What should our Q3 roadmap be?' }] }
    })

    const events = []
    for await (const e of run.events) events.push(e)

    const stagesInOrder = events
      .filter((e) => e.kind === 'provider_event')
      .map((e) => e.stage)
    const firstCritiqueIdx = stagesInOrder.indexOf('critique')
    const firstSynthesisIdx = stagesInOrder.indexOf('synthesis')
    const lastIndependentIdx = stagesInOrder.lastIndexOf('independent')

    expect(lastIndependentIdx).toBeLessThan(firstCritiqueIdx)
    expect(stagesInOrder.lastIndexOf('critique')).toBeLessThan(firstSynthesisIdx)
    expect(stagesInOrder.indexOf('revision')).toBeGreaterThan(stagesInOrder.lastIndexOf('critique'))
    expect(stagesInOrder.lastIndexOf('revision')).toBeLessThan(firstSynthesisIdx)

    const synthesisEvents = events.filter(
      (e) => e.kind === 'provider_event' && e.stage === 'synthesis'
    )
    expect(synthesisEvents.every((e) => e.kind === 'provider_event' && e.providerId === 'anthropic')).toBe(
      true
    )

    expect(events.at(-1)).toMatchObject({ kind: 'run_done', runId: run.runId })
  })

  it('assigns stable, distinct anonymized labels per provider', async () => {
    const claude = makeMockProvider('anthropic')
    const openai = makeMockProvider('openai')

    const run = runCouncil({
      providers: [claude, openai],
      chairId: 'openai',
      request: { messages: [{ role: 'user', content: 'hi' }] }
    })

    const labelsByProvider = new Map<ProviderId, Set<string>>()
    for await (const e of run.events) {
      if (e.kind !== 'provider_event' || !e.label) continue
      const set = labelsByProvider.get(e.providerId) ?? new Set()
      set.add(e.label)
      labelsByProvider.set(e.providerId, set)
    }

    expect(labelsByProvider.get('anthropic')!.size).toBe(1)
    expect(labelsByProvider.get('openai')!.size).toBe(1)
    expect(labelsByProvider.get('anthropic')).not.toEqual(labelsByProvider.get('openai'))
  })

  it('excludes a provider that failed round 1 from the critique round', async () => {
    const claude = makeMockProvider('anthropic')
    const failingGemini: CouncilParticipant = {
      id: 'gemini',
      backend: 'api',
      capabilities: () => ({ streaming: true, tools: false, vision: false }),
      async *generate(): AsyncIterable<CouncilParticipantEvent> {
        yield { type: 'start', runId: 'mock' }
        yield { type: 'error', error: { providerId: 'gemini', code: 'unknown', message: 'boom', retryable: false } }
      }
    }

    const run = runCouncil({
      providers: [claude, failingGemini],
      chairId: 'anthropic',
      request: { messages: [{ role: 'user', content: 'hi' }] }
    })

    const critiqueProviders = new Set<ProviderId>()
    for await (const e of run.events) {
      if (e.kind === 'provider_event' && e.stage === 'critique') critiqueProviders.add(e.providerId)
    }

    expect(critiqueProviders.has('gemini')).toBe(false)
  })

  it('does not use a done answer invalidated by a later policy violation', async () => {
    const unsafe = makeMockProvider('gemini')
    unsafe.generate = async function* () {
      yield { type: 'done', result: { text: 'unsafe answer' } }
      yield { type: 'policy_violation', message: 'changed files' }
    }
    const run = runCouncil({ providers: [makeMockProvider('anthropic'), unsafe], chairId: 'anthropic', request: { messages: [{ role: 'user', content: 'plan' }] } })
    const events = []
    for await (const event of run.events) events.push(event)
    expect(events.some(e => e.kind === 'provider_event' && e.providerId === 'gemini' && e.event.type === 'done')).toBe(false)
    expect(events.some(e => e.kind === 'provider_event' && e.providerId === 'gemini' && e.stage === 'revision')).toBe(false)
  })

  it('copies inputFiles onto critique, revision and synthesis requests', async () => {
    const seen: { stage: string; files: string[] }[] = []
    const tracking: CouncilParticipant = {
      id: 'anthropic',
      backend: 'api',
      capabilities: () => ({ streaming: true, tools: false, vision: true }),
      async *generate(request: CouncilRequest): AsyncIterable<CouncilParticipantEvent> {
        const stage = request.messages[0].content.includes('Kritisiere')
          ? 'critique'
          : request.messages[0].content.includes('Überarbeite')
            ? 'revision'
            : request.messages[0].content.includes('Vorsitz')
              ? 'synthesis'
              : 'independent'
        seen.push({ stage, files: (request.inputFiles ?? []).map((f) => f.path) })
        yield { type: 'start', runId: 'mock' }
        yield { type: 'done', result: { text: `${stage}-ok` } }
      }
    }
    const files = [{ filename: 'shot.png', mimeType: 'image/png', path: 'C:\\tmp\\shot.png' }]
    for await (const _ of runCouncil({
      providers: [tracking, makeMockProvider('openai')],
      chairId: 'anthropic',
      request: { messages: [{ role: 'user', content: 'Beschreibe das Bild.' }], inputFiles: files }
    }).events) { /* drain */ }

    expect(seen.some((s) => s.stage === 'independent' && s.files[0] === 'C:\\tmp\\shot.png')).toBe(true)
    expect(seen.some((s) => s.stage === 'critique' && s.files[0] === 'C:\\tmp\\shot.png')).toBe(true)
    expect(seen.some((s) => s.stage === 'revision' && s.files[0] === 'C:\\tmp\\shot.png')).toBe(true)
    expect(seen.some((s) => s.stage === 'synthesis' && s.files[0] === 'C:\\tmp\\shot.png')).toBe(true)
  })

  it('copies inputFiles onto compact synthesis', async () => {
    const filesOnSynthesis: string[][] = []
    const chair: CouncilParticipant = {
      id: 'openai',
      backend: 'api',
      capabilities: () => ({ streaming: true, tools: false, vision: true }),
      async *generate(request: CouncilRequest): AsyncIterable<CouncilParticipantEvent> {
        if (request.messages[0].content.includes('konsolidiere')) {
          filesOnSynthesis.push((request.inputFiles ?? []).map((f) => f.path))
        }
        yield { type: 'start', runId: 'mock' }
        yield { type: 'done', result: { text: 'ok' } }
      }
    }
    for await (const _ of runCouncil({
      deliberation: 'compact',
      providers: [chair],
      chairId: 'openai',
      request: {
        messages: [{ role: 'user', content: 'Build a calculator' }],
        inputFiles: [{ filename: 'spec.pdf', mimeType: 'application/pdf', path: '/tmp/spec.pdf' }]
      }
    }).events) { /* drain */ }
    expect(filesOnSynthesis).toEqual([['/tmp/spec.pdf']])
  })
})
