import { describe, expect, it } from 'vitest'
import type { CouncilParticipant, CouncilParticipantEvent, CouncilRequest, ProviderId } from '@ai-council/shared'
import { runCompare } from '../orchestrator/compare'

/** Minimal hand-written CouncilParticipant, exercising the contract like a real adapter would. */
function makeMockProvider(id: ProviderId, reply: string): CouncilParticipant {
  return {
    id,
    backend: 'api',
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(_request: CouncilRequest): AsyncIterable<CouncilParticipantEvent> {
      await Promise.resolve()
      yield { type: 'start', runId: 'mock-run' }
      await Promise.resolve()
      yield { type: 'text_delta', text: reply }
      await Promise.resolve()
      yield { type: 'done', result: { text: reply } }
    }
  }
}

function makeFailingProvider(id: ProviderId): CouncilParticipant {
  return {
    id,
    backend: 'api',
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(): AsyncIterable<CouncilParticipantEvent> {
      yield { type: 'start', runId: 'mock-run' }
      yield {
        type: 'error',
        error: { providerId: id, code: 'unknown', message: 'boom', retryable: false }
      }
    }
  }
}

describe('runCompare', () => {
  it('only calls the providers it was given (provider selection)', async () => {
    const claude = makeMockProvider('anthropic', 'hi from claude')
    const gemini = makeMockProvider('gemini', 'hi from gemini')

    const run = runCompare([claude, gemini], { messages: [{ role: 'user', content: 'hello' }] })
    const seenProviders = new Set<ProviderId>()
    for await (const event of run.events) {
      if (event.kind === 'provider_event') seenProviders.add(event.providerId)
    }

    expect(seenProviders).toEqual(new Set<ProviderId>(['anthropic', 'gemini']))
  })

  it('tags every event with the run id and the correct provider, and ends with run_done', async () => {
    const claude = makeMockProvider('anthropic', 'claude says hi')
    const run = runCompare([claude], { messages: [{ role: 'user', content: 'hello' }] })

    const events = []
    for await (const event of run.events) events.push(event)

    expect(events.every((e) => e.runId === run.runId)).toBe(true)
    expect(events.filter((e) => e.kind === 'provider_event').every((e) => e.providerId === 'anthropic')).toBe(
      true
    )
    expect(events.at(-1)).toMatchObject({ kind: 'run_done', runId: run.runId })

    const doneEvent = events.find((e) => e.kind === 'provider_event' && e.event.type === 'done')
    expect(doneEvent).toBeDefined()
  })

  it('one provider failing does not prevent the others from completing', async () => {
    const claude = makeMockProvider('anthropic', 'ok')
    const failingOpenAI = makeFailingProvider('openai')

    const run = runCompare([claude, failingOpenAI], { messages: [{ role: 'user', content: 'hello' }] })
    const events = []
    for await (const event of run.events) events.push(event)

    const anthropicDone = events.some(
      (e) => e.kind === 'provider_event' && e.providerId === 'anthropic' && e.event.type === 'done'
    )
    const openaiError = events.some(
      (e) => e.kind === 'provider_event' && e.providerId === 'openai' && e.event.type === 'error'
    )
    expect(anthropicDone).toBe(true)
    expect(openaiError).toBe(true)
  })

  it('rejects duplicate participant ids instead of silently dropping one', () => {
    const claudeA = makeMockProvider('anthropic', 'a')
    const claudeB = makeMockProvider('anthropic', 'b')
    expect(() => runCompare([claudeA, claudeB], { messages: [{ role: 'user', content: 'hi' }] })).toThrow(
      /Doppelter Council-Teilnehmer/
    )
  })

  it('tags every event with the participant backend', async () => {
    const claude = makeMockProvider('anthropic', 'hi')
    const run = runCompare([claude], { messages: [{ role: 'user', content: 'hello' }] })
    const events = []
    for await (const event of run.events) events.push(event)
    expect(events.filter((e) => e.kind === 'provider_event').every((e) => e.backend === 'api')).toBe(true)
  })
})
