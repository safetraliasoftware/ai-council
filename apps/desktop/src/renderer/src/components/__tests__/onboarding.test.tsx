import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsState } from '../../../../main/ipc-types'

vi.mock('../Settings', () => ({ default: () => 'settings-embedded' }))
import Onboarding from '../Onboarding'

afterEach(() => vi.unstubAllGlobals())

it('welcomes a first-time user and embeds the real settings UI', () => {
  vi.stubGlobal('React', React)
  const settings: SettingsState = {
    anthropic: { hasKey: false, model: '', backend: 'api' },
    openai: { hasKey: false, model: '', backend: 'api' },
    gemini: { hasKey: false, model: '', backend: 'api' },
    xai: { hasKey: false, model: '', backend: 'api' }
  }
  const html = renderToStaticMarkup(
    <Onboarding settings={settings} onSettingsChange={async () => {}} onComplete={() => {}} />
  )
  expect(html).toContain('Willkommen bei AI Council')
  expect(html).toContain('settings-embedded')
  expect(html).toContain('Weiter zur App')
})
