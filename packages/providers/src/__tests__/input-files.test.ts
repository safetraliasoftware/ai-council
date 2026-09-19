import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  toAnthropicUserContent,
  toGeminiParts,
  toOpenAIUserContent,
  toXaiResponseInput
} from '../input-files'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const MINI_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
)

describe('input-file mappers', () => {
  let dir: string
  let png: string
  let pdf: string
  let gif: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-input-'))
    png = join(dir, 'shot.png')
    pdf = join(dir, 'spec.pdf')
    gif = join(dir, 'anim.gif')
    writeFileSync(png, PNG_1X1)
    writeFileSync(pdf, MINI_PDF)
    writeFileSync(gif, Buffer.from('GIF89a'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('maps a PNG and PDF into Anthropic image/document blocks plus the user text', async () => {
    const blocks = await toAnthropicUserContent('Was siehst du?', [
      { filename: 'shot.png', mimeType: 'image/png', path: png },
      { filename: 'spec.pdf', mimeType: 'application/pdf', path: pdf }
    ])
    expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } })
    expect(blocks[1]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } })
    expect(blocks.at(-1)).toEqual({ type: 'text', text: 'Was siehst du?' })
    expect((blocks[0] as { source: { data: string } }).source.data.length).toBeGreaterThan(10)
  })

  it('maps a PNG as image_url and a PDF as file for OpenAI chat completions', async () => {
    const parts = await toOpenAIUserContent('Was siehst du?', [
      { filename: 'shot.png', mimeType: 'image/png', path: png },
      { filename: 'spec.pdf', mimeType: 'application/pdf', path: pdf }
    ])
    expect(parts[0]).toEqual({ type: 'text', text: 'Was siehst du?' })
    expect(parts[1]).toMatchObject({ type: 'image_url' })
    expect((parts[1] as { image_url: { url: string } }).image_url.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(parts[2]).toMatchObject({ type: 'file', file: { filename: 'spec.pdf' } })
    expect((parts[2] as { file: { file_data: string } }).file.file_data.startsWith('data:application/pdf;base64,')).toBe(true)
  })

  it('maps files as Gemini inlineData parts', async () => {
    const parts = await toGeminiParts('Was siehst du?', [
      { filename: 'shot.png', mimeType: 'image/png', path: png },
      { filename: 'spec.pdf', mimeType: 'application/pdf', path: pdf }
    ])
    expect(parts[0]).toMatchObject({ inlineData: { mimeType: 'image/png' } })
    expect(parts[1]).toMatchObject({ inlineData: { mimeType: 'application/pdf' } })
    expect(parts.at(-1)).toEqual({ text: 'Was siehst du?' })
  })

  it('maps xAI Responses input_image and skips PDF and GIF with a note instead of failing the run', async () => {
    const parts = await toXaiResponseInput('Was siehst du?', [
      { filename: 'shot.png', mimeType: 'image/png', path: png }
    ])
    expect(parts[0]).toEqual({ type: 'input_text', text: 'Was siehst du?' })
    expect(parts[1]).toMatchObject({ type: 'input_image', detail: 'high' })

    const skipped = await toXaiResponseInput('x', [
      { filename: 'spec.pdf', mimeType: 'application/pdf', path: pdf },
      { filename: 'anim.gif', mimeType: 'image/gif', path: gif }
    ])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ type: 'input_text' })
    expect((skipped[0] as { text: string }).text).toContain('spec.pdf')
    expect((skipped[0] as { text: string }).text).toContain('anim.gif')
    expect((skipped[0] as { text: string }).text).toContain('JPEG/PNG')
  })
})
