import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import CouncilUsage from '../CouncilUsage'

afterEach(() => vi.unstubAllGlobals())
it('distinguishes unknown usage from a reported zero and labels calls accurately', () => {
  vi.stubGlobal('React', React)
  const html = renderToStaticMarkup(<CouncilUsage calls={[
    { providerId: 'anthropic', backend: 'local_agent', stage: 'critique', inputChars: 100, outputChars: 20,
      durationMs: 500, outcome: 'completed', inputTokens: 0, costUsd: 0 }
  ]} />)
  expect(html).toContain('1 Teilnehmeraufrufe')
  expect(html).toContain('Kritik')
  expect(html).toContain('0 / Nicht gemeldet')
  expect(html).toContain('$0.0000')
  expect(html).toContain('kein verbleibendes Abo-Kontingent')
})
