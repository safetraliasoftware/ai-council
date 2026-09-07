import { describe, expect, it } from 'vitest'
import type { AIProvider, CouncilRequest, ProviderEvent, ProviderId } from '@ai-council/shared'
import { runCouncil } from '../orchestrator/council'

function makeMockProvider(id: ProviderId): AIProvider {
  return {
    id,
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(request: CouncilRequest): AsyncIterable<ProviderEvent> {
      const reply = `${id}-reply-to(${request.messages[0].content.length}chars)`
      yield { type: 'start', runId: 'mock' }
      yield { type: 'text_delta', text: reply }
      yield { type: 'done', result: { text: reply } }
    }
  }
}

describe('runCouncil', () => {
  it('runs independent -> critique -> synthesis in that order, chair only synthesizes', async () => {
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

    const synthesisEvents = events.filter(
      (e) => e.kind === 'provider_event' && e.stage === 'synthesis'
    )
    expect(synthesisEvents.every((e) => e.kind === 'provider_event' && e.providerId === 'anthropic')).toBe(
      true
    )

    expect(events.at(-1)).toEqual({ kind: 'run_done', runId: run.runId })
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
    const failingGemini: AIProvider = {
      id: 'gemini',
      capabilities: () => ({ streaming: true, tools: false, vision: false }),
      async *generate(): AsyncIterable<ProviderEvent> {
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
})
