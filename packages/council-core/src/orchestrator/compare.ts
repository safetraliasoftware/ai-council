import { RunUsageTracker } from '../run-usage'
import { randomUUID } from 'node:crypto'
import type { CouncilParticipant, CouncilRequest, GenerateOptions } from '@ai-council/shared'
import type { CouncilRun, CouncilRunEvent } from '../events'
import { mergeAsyncIterables } from '../merge-async-iterables'
import { assertUniqueParticipantIds } from '../assert-unique-ids'

/**
 * Compare mode: the same request goes to every participant independently and
 * concurrently. No participant sees another's output. council-core owns this
 * orchestration - hosts (Electron, CLI, ...) only forward the resulting
 * events, they never fan the request out themselves.
 */
export function runCompare(
  providers: CouncilParticipant[],
  request: CouncilRequest,
  options?: GenerateOptions
): CouncilRun {
  assertUniqueParticipantIds(providers)
  const runId = randomUUID()
  const usage = new RunUsageTracker()

  async function* run(): AsyncGenerator<CouncilRunEvent> {
    const perProviderStreams = providers.map((provider) => {
      async function* tagged(): AsyncGenerator<CouncilRunEvent> {
        for await (const event of usage.generate(provider, request, options)) {
          yield { kind: 'provider_event', runId, providerId: provider.id, backend: provider.backend, event }
        }
      }
      return tagged()
    })
    yield* mergeAsyncIterables(perProviderStreams)
    yield { kind: 'run_done', runId, usage: usage.calls }
  }

  return { runId, events: run(), usage: usage.calls, observeUsage: listener => { usage.onChange = listener } }
}
