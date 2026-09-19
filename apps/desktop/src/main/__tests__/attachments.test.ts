import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyFile,
  rememberAllowedAttachmentPath,
  resetAllowedAttachmentPaths,
  toInputFiles,
  withAttachments
} from '../attachments'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

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

  it('does not inline file-kind attachments into the prompt', () => {
    const result = withAttachments('Schau dir das an.', [
      { kind: 'inline-text', label: 'Datei: notes.txt', text: 'Notizen' },
      { kind: 'file', label: 'shot.png', path: 'C:\\tmp\\shot.png', mimeType: 'image/png', filename: 'shot.png' }
    ])
    expect(result).toContain('Notizen')
    expect(result).not.toContain('shot.png')
  })
})

describe('classifyFile', () => {
  it('detects PNG, JPEG, PDF and UTF-8 text from magic bytes / contents', () => {
    expect(classifyFile('x.png', PNG_1X1)).toEqual({ kind: 'image', mimeType: 'image/png' })
    expect(classifyFile('x.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ kind: 'image', mimeType: 'image/jpeg' })
    expect(classifyFile('x.pdf', Buffer.from('%PDF-1.4 rest'))).toEqual({ kind: 'pdf', mimeType: 'application/pdf' })
    expect(classifyFile('notes.txt', Buffer.from('hello world'))).toEqual({ kind: 'text', mimeType: 'text/plain' })
    expect(classifyFile('blob.bin', Buffer.from([0, 1, 2, 3, 4]))).toEqual({ kind: 'unsupported', mimeType: 'application/octet-stream' })
  })
})

describe('toInputFiles', () => {
  let dir: string

  afterEach(() => {
    resetAllowedAttachmentPaths()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('turns file-kind artifacts into InputFile pointers after checking they exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-attach-'))
    const path = join(dir, 'shot.png')
    writeFileSync(path, PNG_1X1)
    rememberAllowedAttachmentPath(path)
    const files = await toInputFiles([
      { kind: 'inline-text', label: 'notes', text: 'hi' },
      { kind: 'file', label: 'shot.png', path, mimeType: 'image/png', filename: 'shot.png' }
    ])
    expect(files).toEqual([{ filename: 'shot.png', mimeType: 'image/png', path }])
  })

  it('rejects a renderer-supplied path that was never picked in a file dialog', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-attach-'))
    const path = join(dir, 'secret.png')
    writeFileSync(path, PNG_1X1)
    await expect(
      toInputFiles([{ kind: 'file', label: 'secret.png', path, mimeType: 'image/png', filename: 'secret.png' }])
    ).rejects.toThrow(/Dateiauswahl-Dialog/)
  })
})
