import { randomUUID } from 'node:crypto'
import type { AIProvider, CouncilRequest, GenerateOptions } from '@ai-council/shared'
import type { CouncilRun, CouncilRunEvent } from '../events'

export interface TeamStep {
  provider: AIProvider
  roleInstruction: string
}

/**
 * Team mode: steps run in order, each provider's full text output becomes
 * part of the next step's context. This is a fixed pipeline for Phase 1 -
 * the richer Council protocol (independent round -> critique -> synthesis)
 * is a separate orchestrator function to add later; it will live here too,
 * never in the host/UI layer.
 */
export function runTeam(
  steps: TeamStep[],
  initialPrompt: string,
  options?: GenerateOptions
): CouncilRun {
  const runId = randomUUID()

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
      for await (const event of step.provider.generate(request, options)) {
        yield { kind: 'provider_event', runId, providerId: step.provider.id, stepIndex: i, event }
        if (event.type === 'done') context = event.result.text
        if (event.type === 'error') stepFailed = true
      }
      if (stepFailed) {
        yield { kind: 'run_done', runId }
        return
      }
    }
    yield { kind: 'run_done', runId }
  }

  return { runId, events: run() }
}
