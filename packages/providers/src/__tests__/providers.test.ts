import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../anthropic'
import { OpenAIProvider } from '../openai'
import { GeminiProvider } from '../gemini'
import { XAIProvider } from '../xai'

// Construction only - the SDK clients don't make network calls until a
// request method is actually invoked, so this is safe without a real key.
describe('provider adapters implement the AIProvider contract', () => {
  it('AnthropicProvider exposes id and capabilities', () => {
    const provider = new AnthropicProvider({ apiKey: 'fake-key', model: 'claude-opus-5' })
    expect(provider.id).toBe('anthropic')
    expect(provider.capabilities()).toEqual({ streaming: true, tools: false, vision: true })
  })

  it('OpenAIProvider exposes id and capabilities', () => {
    const provider = new OpenAIProvider({ apiKey: 'fake-key', model: 'gpt-5.1' })
    expect(provider.id).toBe('openai')
    expect(provider.capabilities()).toEqual({ streaming: true, tools: false, vision: true })
  })

  it('GeminiProvider exposes id and capabilities', () => {
    const provider = new GeminiProvider({ apiKey: 'fake-key', model: 'gemini-3-pro-preview' })
    expect(provider.id).toBe('gemini')
    expect(provider.capabilities()).toEqual({ streaming: true, tools: false, vision: true })
  })

  it('XAIProvider exposes id and capabilities', () => {
    const provider = new XAIProvider({ apiKey: 'fake-key', model: 'grok-4.6' })
    expect(provider.id).toBe('xai')
    expect(provider.capabilities()).toEqual({ streaming: true, tools: false, vision: true })
  })
})
