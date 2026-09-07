import { randomUUID } from 'node:crypto'
import type { AIProvider, CouncilRequest, GenerateOptions } from '@ai-council/shared'
import type { CouncilRun, CouncilRunEvent } from '../events'
import { mergeAsyncIterables } from '../merge-async-iterables'

/**
 * Compare mode: the same request goes to every provider independently and
 * concurrently. No provider sees another's output. council-core owns this
 * orchestration - hosts (Electron, CLI, ...) only forward the resulting
 * events, they never fan the request out themselves.
 */
export function runCompare(
  providers: AIProvider[],
  request: CouncilRequest,
  options?: GenerateOptions
): CouncilRun {
  const runId = randomUUID()

  async function* run(): AsyncGenerator<CouncilRunEvent> {
    const perProviderStreams = providers.map((provider) => {
      async function* tagged(): AsyncGenerator<CouncilRunEvent> {
        for await (const event of provider.generate(request, options)) {
          yield { kind: 'provider_event', runId, providerId: provider.id, event }
        }
      }
      return tagged()
    })
    yield* mergeAsyncIterables(perProviderStreams)
    yield { kind: 'run_done', runId }
  }

  return { runId, events: run() }
}
