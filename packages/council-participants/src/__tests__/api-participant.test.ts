import { describe, expect, it } from 'vitest'
import type { AIProvider, CouncilParticipantEvent, CouncilRequest, ProviderEvent } from '@ai-council/shared'
import { toApiCouncilParticipant } from '../api-participant'

function fakeProvider(): AIProvider {
  return {
    id: 'anthropic',
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(_request: CouncilRequest): AsyncIterable<ProviderEvent> {
      yield { type: 'start', runId: 'r1' }
      yield { type: 'text_delta', text: 'hi' }
      yield { type: 'done', result: { text: 'hi' } }
    }
  }
}

describe('toApiCouncilParticipant', () => {
  it('exposes the wrapped provider id and backend "api"', () => {
    const participant = toApiCouncilParticipant(fakeProvider())
    expect(participant.id).toBe('anthropic')
    expect(participant.backend).toBe('api')
  })

  it('passes ProviderEvents through unchanged', async () => {
    const participant = toApiCouncilParticipant(fakeProvider())
    const events: CouncilParticipantEvent[] = []
    for await (const e of participant.generate({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(events).toEqual([
      { type: 'start', runId: 'r1' },
      { type: 'text_delta', text: 'hi' },
      { type: 'done', result: { text: 'hi' } }
    ])
  })
})
