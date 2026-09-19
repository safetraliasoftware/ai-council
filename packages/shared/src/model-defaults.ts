import type { ProviderId } from './contracts'

/**
 * The only place a default model id is allowed to appear. Everything else
 * (providers, council-core, hosts) reads the active model through a
 * ModelRegistry that is seeded from here and overridable by the user.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.1',
  gemini: 'gemini-3-pro-preview',
  xai: 'grok-4.6'
}
