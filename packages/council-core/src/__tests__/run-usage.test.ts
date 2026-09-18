import { describe, expect, it } from 'vitest'
import type { CouncilParticipant, CouncilParticipantEvent } from '@ai-council/shared'
import { runCouncil } from '../orchestrator/council'
import { runCompare } from '../orchestrator/compare'
import { runTeam } from '../orchestrator/team'

function participant(events: CouncilParticipantEvent[]): CouncilParticipant {
  return { id: 'anthropic', backend: 'local_agent', capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate() { yield* events } }
}
const request = { messages: [{ role: 'user' as const, content: 'Task' }] }

describe('participant usage accounting', () => {
  it('records every full Council phase and does not double count usage plus done snapshots', async () => {
    const p = participant([
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'done', result: { text: 'answer', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 } } }
    ])
    const events = []
    for await (const e of runCouncil({ providers: [p], chairId: p.id, request }).events) events.push(e)
    const final = events.at(-1)!
    expect(final.kind).toBe('run_done')
    if (final.kind !== 'run_done') throw new Error('missing completion')
    expect(final.usage?.map(c => c.stage)).toEqual(['independent', 'critique', 'revision', 'synthesis'])
    expect(final.usage?.every(c => c.inputTokens === 10 && c.outputTokens === 2 && c.costUsd === 0 && c.outcome === 'completed')).toBe(true)
  })

  it('retains spent usage even when a policy violation rejects the answer', async () => {
    const p = participant([{ type: 'done', result: { text: 'answer', usage: { inputTokens: 7 } } },
      { type: 'policy_violation', message: 'workspace changed' }])
    const events = []
    for await (const e of runCouncil({ providers: [p], chairId: p.id, request }).events) events.push(e)
    expect(events.filter(e => e.kind === 'provider_event' && e.event.type === 'done')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ usage: [{ inputTokens: 7, outcome: 'failed' }] })
    const final = events.at(-1)!
    if (final.kind !== 'run_done') throw new Error('missing completion')
    expect(final.usage![0].outputTokens).toBeUndefined()
  })

  it('never starts participants after cancellation, including Team follow-up steps', async () => {
    const controller = new AbortController()
    let calls = 0
    const p = participant([])
    p.generate = async function* () {
      calls++
      yield { type: 'done', result: { text: 'answer' } }
      controller.abort()
    }
    const events = []
    for await (const e of runTeam([{ provider: p, roleInstruction: 'one' }, { provider: p, roleInstruction: 'two' }], 'Task', { signal: controller.signal }).events) events.push(e)
    expect(calls).toBe(1)
    expect(events.at(-1)).toMatchObject({ usage: [{ outcome: 'cancelled', stepIndex: 0 }] })
    for await (const _ of runCouncil({ providers: [p], chairId: p.id, request, options: { signal: controller.signal } }).events) { /* drain */ }
    for await (const _ of runCompare([p], request, { signal: controller.signal }).events) { /* drain */ }
    expect(calls).toBe(1)
  })

  it('records distinct invocations when the same provider fills multiple Team roles', async () => {
    const p = participant([{ type: 'done', result: { text: 'answer' } }])
    const events = []
    for await (const e of runTeam([{ provider: p, roleInstruction: 'one' }, { provider: p, roleInstruction: 'two' }], 'Task').events) events.push(e)
    expect(events.at(-1)).toMatchObject({ usage: [{ stepIndex: 0, outcome: 'completed' }, { stepIndex: 1, outcome: 'completed' }] })
  })
})
