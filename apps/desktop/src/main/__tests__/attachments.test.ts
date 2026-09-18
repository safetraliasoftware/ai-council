import { describe, expect, it } from 'vitest'
import { withAttachments } from '../attachments'

describe('withAttachments', () => {
  it('returns the prompt unchanged when there are no attachments', () => {
    expect(withAttachments('Was denkst du?', undefined)).toBe('Was denkst du?')
    expect(withAttachments('Was denkst du?', [])).toBe('Was denkst du?')
  })

  it('appends one attachment with a clear header, after the prompt', () => {
    const result = withAttachments('Prüfe diesen Diff.', [{ label: 'Git-Diff: SecKalkulation', text: '+ added line' }])

    expect(result.startsWith('Prüfe diesen Diff.')).toBe(true)
    expect(result).toContain('--- Anhang: Git-Diff: SecKalkulation ---')
    expect(result).toContain('+ added line')
  })

  it('appends multiple attachments in order, each with its own header', () => {
    const result = withAttachments('Was meint ihr?', [
      { label: 'Datei: a.txt', text: 'Inhalt A' },
      { label: 'Datei: b.txt', text: 'Inhalt B' }
    ])

    const indexA = result.indexOf('Inhalt A')
    const indexB = result.indexOf('Inhalt B')
    expect(indexA).toBeGreaterThan(-1)
    expect(indexB).toBeGreaterThan(indexA)
    expect(result).toContain('--- Anhang: Datei: a.txt ---')
    expect(result).toContain('--- Anhang: Datei: b.txt ---')
  })
})
