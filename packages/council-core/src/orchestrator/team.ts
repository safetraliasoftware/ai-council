import { RunUsageTracker } from '../run-usage'
import { randomUUID } from 'node:crypto'
import type { CouncilParticipant, CouncilRequest, GenerateOptions } from '@ai-council/shared'
import type { CouncilRun, CouncilRunEvent } from '../events'

export interface TeamStep {
  provider: CouncilParticipant
  roleInstruction: string
}

/**
 * Team mode: steps run in order, each provider's full text output becomes
 * part of the next step's context. This is a fixed pipeline for Phase 1 -
 * the richer Council protocol (independent round -> critique -> synthesis)
 * is a separate orchestrator function to add later; it will live here too,
 * never in the host/UI layer.
 *
 * Deliberately no assertUniqueParticipantIds() call here (unlike Compare/
 * Council): those key their results by provider.id to merge/anonymize
 * candidates, so a duplicate id would silently overwrite one result with
 * another's. Team keys everything by step INDEX instead (see the
 * `stepIndex` on each emitted event) - the same provider can legitimately
 * run two steps in a row (e.g. "draft, then refine your own draft"), and
 * nothing here breaks if it does.
 */
export function runTeam(
  steps: TeamStep[],
  initialPrompt: string,
  options?: GenerateOptions
): CouncilRun {
  const runId = randomUUID()
  const usage = new RunUsageTracker()

  async function* run(): AsyncGenerator<CouncilRunEvent> {
    let context = initialPrompt
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const userPrompt =
        i === 0
          ? initialPrompt
          : `Ursprüngliche Aufgabe:\n${initialPrompt}\n\nErgebnis des vorherigen Schritts:\n${context}\n\nDeine Aufgabe: ${step.roleInstruction}`
      const request: CouncilRequest = {
        systemInstructions: i === 0 ? step.roleInstruction : undefined,
        messages: [{ role: 'user', content: userPrompt }]
      }

      let stepFailed = false
      for await (const event of usage.generate(step.provider, request, options, undefined, i)) {
        yield {
          kind: 'provider_event',
          runId,
          providerId: step.provider.id,
          backend: step.provider.backend,
          stepIndex: i,
          event
        }
        if (event.type === 'done') context = event.result.text
        if (event.type === 'error') stepFailed = true
      }
      if (stepFailed) {
        yield { kind: 'run_done', runId, usage: usage.calls }
        return
      }
    }
    yield { kind: 'run_done', runId, usage: usage.calls }
  }

  return { runId, events: run(), usage: usage.calls, observeUsage: listener => { usage.onChange = listener } }
}
