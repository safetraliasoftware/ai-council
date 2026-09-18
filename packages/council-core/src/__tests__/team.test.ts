import { describe, expect, it } from 'vitest'
import type { CouncilParticipant, CouncilParticipantEvent, CouncilRequest, ProviderId } from '@ai-council/shared'
import { runTeam } from '../orchestrator/team'

function makeMockProvider(id: ProviderId, reply: string): CouncilParticipant {
  return {
    id,
    backend: 'api',
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(_request: CouncilRequest): AsyncIterable<CouncilParticipantEvent> {
      await Promise.resolve()
      yield { type: 'start', runId: 'mock-run' }
      yield { type: 'done', result: { text: reply } }
    }
  }
}

describe('runTeam', () => {
  it('runs each step in order, feeding the previous result forward', async () => {
    const claude = makeMockProvider('anthropic', 'draft')
    const gemini = makeMockProvider('gemini', 'refined')

    const run = runTeam(
      [
        { provider: claude, roleInstruction: 'Draft it.' },
        { provider: gemini, roleInstruction: 'Refine it.' }
      ],
      'initial task'
    )
    const events = []
    for await (const event of run.events) events.push(event)

    expect(events.at(-1)).toMatchObject({ kind: 'run_done', runId: run.runId })
    const doneEvents = events.filter((e) => e.kind === 'provider_event' && e.event.type === 'done')
    expect(doneEvents).toHaveLength(2)
  })

  it('REGRESSION (Team-Modus lief gar nicht mehr): the same provider can run two steps in a row without throwing', async () => {
    // Unlike Compare/Council, Team keys everything by stepIndex, not
    // provider.id - a duplicate id here is a legitimate "draft, then refine
    // your own draft" pipeline, not an ambiguity. Caught live: adding a
    // second step (which defaults to the same provider) and running it
    // synchronously threw before any event was emitted, and neither the IPC
    // handler nor the renderer caught it - "Läuft…" hung forever with no
    // error shown.
    const claudeStep1 = makeMockProvider('anthropic', 'draft')
    const claudeStep2 = makeMockProvider('anthropic', 'refined')

    const run = runTeam(
      [
        { provider: claudeStep1, roleInstruction: 'Draft it.' },
        { provider: claudeStep2, roleInstruction: 'Refine your own draft.' }
      ],
      'initial task'
    )
    const events = []
    for await (const event of run.events) events.push(event)

    expect(events.at(-1)).toMatchObject({ kind: 'run_done', runId: run.runId })
    const doneEvents = events.filter((e) => e.kind === 'provider_event' && e.event.type === 'done')
    expect(doneEvents).toHaveLength(2)
  })

  it('a failing step stops the pipeline instead of continuing with a stale context', async () => {
    const failing: CouncilParticipant = {
      id: 'anthropic',
      backend: 'api',
      capabilities: () => ({ streaming: true, tools: false, vision: false }),
      async *generate(): AsyncIterable<CouncilParticipantEvent> {
        yield { type: 'start', runId: 'mock-run' }
        yield { type: 'error', error: { providerId: 'anthropic', code: 'unknown', message: 'boom', retryable: false } }
      }
    }
    const gemini = makeMockProvider('gemini', 'never reached')

    const run = runTeam(
      [
        { provider: failing, roleInstruction: 'Draft it.' },
        { provider: gemini, roleInstruction: 'Refine it.' }
      ],
      'initial task'
    )
    const events = []
    for await (const event of run.events) events.push(event)

    const geminiRan = events.some((e) => e.kind === 'provider_event' && e.providerId === 'gemini')
    expect(geminiRan).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'run_done', runId: run.runId })
  })
})
