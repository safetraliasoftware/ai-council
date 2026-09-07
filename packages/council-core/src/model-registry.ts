import type { ProviderId } from '@ai-council/shared'
import { DEFAULT_MODELS } from '@ai-council/shared'

/**
 * The only place in council-core (or any consumer) that resolves a model id.
 * No provider adapter, orchestrator, or UI component should hardcode a model
 * string - they all go through this.
 */
export interface ModelRegistry {
  getModel(providerId: ProviderId): string
}

export function createModelRegistry(
  overrides: Partial<Record<ProviderId, string>> = {}
): ModelRegistry {
  const models: Record<ProviderId, string> = { ...DEFAULT_MODELS, ...overrides }
  return {
    getModel: (providerId) => models[providerId]
  }
}
