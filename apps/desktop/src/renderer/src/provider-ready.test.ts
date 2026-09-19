import { describe, expect, it } from 'vitest'
import type { ExecutorAvailability } from '@ai-council/coding'
import type { CodingExecutorId, SettingsState } from '../../main/ipc-types'
import { isProviderReady, readyProviderIds } from './provider-ready'

const emptyDetect: Partial<Record<CodingExecutorId, ExecutorAvailability>> = {}
const localReady: Partial<Record<CodingExecutorId, ExecutorAvailability>> = {
  'claude-code-cli': { installed: true, authStatus: 'authenticated' }
}
const localUnauthed: Partial<Record<CodingExecutorId, ExecutorAvailability>> = {
  'claude-code-cli': { installed: true, authStatus: 'unauthenticated' }
}

function settings(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    anthropic: { hasKey: false, model: '', backend: 'auto' },
    openai: { hasKey: false, model: '', backend: 'auto' },
    gemini: { hasKey: false, model: '', backend: 'auto' },
    xai: { hasKey: false, model: '', backend: 'auto' },
    ...overrides
  }
}

describe('isProviderReady', () => {
  it('treats an API backend as ready only when a key is saved', () => {
    expect(isProviderReady('anthropic', settings({ anthropic: { hasKey: true, model: 'x', backend: 'api' } }), emptyDetect)).toBe(true)
    expect(isProviderReady('anthropic', settings({ anthropic: { hasKey: false, model: 'x', backend: 'api' } }), emptyDetect)).toBe(false)
  })

  it('treats auto as ready with a local agent or a saved key, not with the fallback checkbox alone', () => {
    expect(isProviderReady('anthropic', settings(), localReady)).toBe(true)
    expect(isProviderReady('anthropic', settings({ anthropic: { hasKey: true, model: 'x', backend: 'auto' } }), emptyDetect)).toBe(true)
    expect(isProviderReady('anthropic', settings(), emptyDetect)).toBe(false)
    expect(isProviderReady('anthropic', settings(), localUnauthed)).toBe(false)
  })

  it('treats a local backend as ready only when the agent is installed and not unauthenticated', () => {
    expect(isProviderReady('anthropic', settings({ anthropic: { hasKey: false, model: '', backend: 'local' } }), localReady)).toBe(true)
    expect(isProviderReady('anthropic', settings({ anthropic: { hasKey: true, model: 'x', backend: 'local' } }), emptyDetect)).toBe(false)
  })
})

describe('readyProviderIds', () => {
  it('returns only seats that can actually run', () => {
    const state = settings({
      anthropic: { hasKey: true, model: 'x', backend: 'api' },
      openai: { hasKey: false, model: '', backend: 'api' }
    })
    expect(readyProviderIds(state, emptyDetect)).toEqual(['anthropic'])
  })
})
