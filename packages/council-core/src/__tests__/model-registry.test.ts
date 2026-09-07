import { describe, expect, it } from 'vitest'
import { createModelRegistry } from '../model-registry'
import { DEFAULT_MODELS } from '@ai-council/shared'

describe('createModelRegistry', () => {
  it('falls back to DEFAULT_MODELS when no override is given', () => {
    const registry = createModelRegistry()
    expect(registry.getModel('anthropic')).toBe(DEFAULT_MODELS.anthropic)
    expect(registry.getModel('openai')).toBe(DEFAULT_MODELS.openai)
    expect(registry.getModel('gemini')).toBe(DEFAULT_MODELS.gemini)
  })

  it('lets a per-provider override win over the default', () => {
    const registry = createModelRegistry({ anthropic: 'claude-custom-1' })
    expect(registry.getModel('anthropic')).toBe('claude-custom-1')
    expect(registry.getModel('openai')).toBe(DEFAULT_MODELS.openai)
  })
})
