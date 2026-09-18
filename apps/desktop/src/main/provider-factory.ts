import { randomUUID } from 'node:crypto'
import type { AIProvider, ProviderId } from '@ai-council/shared'
import { AnthropicProvider, OpenAIProvider, GeminiProvider } from '@ai-council/providers'
import type { ElectronSecretStore } from './secret-store'
import type { ModelConfig } from './model-config'

/**
 * Returns a stand-in AIProvider that immediately reports a config error.
 * Keeps "no key configured" flowing through the same ProviderEvent
 * vocabulary as a real failure, instead of a second ad-hoc error channel.
 */
function missingKeyProvider(id: ProviderId): AIProvider {
  return {
    id,
    capabilities: () => ({ streaming: false, tools: false, vision: false }),
    async *generate() {
      yield { type: 'start' as const, runId: randomUUID() }
      yield {
        type: 'error' as const,
        error: {
          providerId: id,
          code: 'auth' as const,
          message: 'Kein API-Key für diesen Anbieter hinterlegt.',
          retryable: false
        }
      }
    }
  }
}

/** Shared by ipc.ts and project-spec-ipc.ts so both build providers identically. */
export function createProviderFactory(
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig
): (id: ProviderId) => AIProvider {
  return (id: ProviderId): AIProvider => {
    const apiKey = secretStore.getKey(id)
    const model = modelConfig.getModel(id)
    if (!apiKey) return missingKeyProvider(id)
    switch (id) {
      case 'anthropic':
        return new AnthropicProvider({ apiKey, model })
      case 'openai':
        return new OpenAIProvider({ apiKey, model })
      case 'gemini':
        return new GeminiProvider({ apiKey, model })
    }
  }
}
