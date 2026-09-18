import type { CouncilParticipant, CouncilParticipantEvent, CouncilRequest, GenerateOptions, Usage } from '@ai-council/shared'
import type { CouncilStage } from './events'
import { randomUUID } from 'node:crypto'

export interface CouncilCallUsage extends Usage {
  callId?: string
  startedAt?: number
  providerId: CouncilParticipant['id']
  backend: CouncilParticipant['backend']
  stage?: CouncilStage
  stepIndex?: number
  inputChars: number
  outputChars: number
  durationMs: number
  outcome: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
}

/** One entry per participant invocation, not per internal model/tool call.
 * Missing provider measurements stay missing; usage snapshots are not deltas.
 */
export class RunUsageTracker {
  readonly calls: CouncilCallUsage[] = []
  onChange?: () => void

  async *generate(provider: CouncilParticipant, request: CouncilRequest, options?: GenerateOptions,
    stage?: CouncilStage, stepIndex?: number): AsyncGenerator<CouncilParticipantEvent> {
    if (options?.signal?.aborted) return
    const startedAt = Date.now()
    const call: CouncilCallUsage = {
      callId: randomUUID(), startedAt,
      providerId: provider.id, backend: provider.backend, stage, stepIndex,
      inputChars: (request.systemInstructions?.length ?? 0) + request.messages.reduce((n, m) => n + m.content.length, 0),
      outputChars: 0, durationMs: 0, outcome: 'running'
    }
    this.calls.push(call)
    this.onChange?.()
    let done = false, invalid = false
    try {
      for await (const event of provider.generate(request, options)) {
        if (event.type === 'text_delta') call.outputChars += event.text.length
        if (event.type === 'error' || event.type === 'policy_violation') invalid = true
        if (event.type === 'done') {
          done = true
          call.outputChars = Math.max(call.outputChars, event.result.text.length)
        }
        const usage = event.type === 'usage' ? event.usage : event.type === 'done' ? event.result.usage : undefined
        for (const field of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
          const value = usage?.[field]
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) call[field] = value
        }
        if (usage) this.onChange?.()
        yield event
      }
      call.outcome = done && !invalid ? 'completed' : 'failed'
    } finally {
      if (options?.signal?.aborted) call.outcome = 'cancelled'
      else if (call.outcome === 'running') call.outcome = 'failed'
      call.durationMs = Date.now() - startedAt
      this.onChange?.()
    }
  }
}
