import { readFile } from 'node:fs/promises'
import type { InputFile } from '@ai-council/shared'

export const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
export const OPENAI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
export const GEMINI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
/** xAI image-understanding docs: jpg/jpeg or png only. */
export const XAI_IMAGE_TYPES = new Set(['image/jpeg', 'image/png'])

export interface LoadedInputFile {
  filename: string
  mimeType: string
  base64: string
}

export async function loadInputFile(file: InputFile): Promise<LoadedInputFile> {
  const bytes = await readFile(file.path)
  return { filename: file.filename, mimeType: file.mimeType, base64: bytes.toString('base64') }
}

export function isPdf(mimeType: string): boolean {
  return mimeType === 'application/pdf'
}

export function dataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`
}

export class UnsupportedInputFileError extends Error {
  readonly code = 'invalid_request' as const
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedInputFileError'
  }
}

export type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }

export async function toAnthropicUserContent(text: string, files: InputFile[]): Promise<AnthropicUserContentBlock[]> {
  const blocks: AnthropicUserContentBlock[] = []
  for (const file of files) {
    const loaded = await loadInputFile(file)
    if (isPdf(loaded.mimeType)) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: loaded.base64 } })
      continue
    }
    if (!ANTHROPIC_IMAGE_TYPES.has(loaded.mimeType)) {
      throw new UnsupportedInputFileError(`Claude kann ${file.filename} (${file.mimeType}) nicht als Bild/PDF lesen.`)
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: loaded.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: loaded.base64
      }
    })
  }
  blocks.push({ type: 'text', text })
  return blocks
}

export type OpenAIUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export async function toOpenAIUserContent(text: string, files: InputFile[]): Promise<OpenAIUserContentPart[]> {
  const parts: OpenAIUserContentPart[] = [{ type: 'text', text }]
  for (const file of files) {
    const loaded = await loadInputFile(file)
    if (isPdf(loaded.mimeType)) {
      parts.push({ type: 'file', file: { filename: loaded.filename, file_data: dataUrl(loaded.mimeType, loaded.base64) } })
      continue
    }
    if (!OPENAI_IMAGE_TYPES.has(loaded.mimeType)) {
      throw new UnsupportedInputFileError(`ChatGPT kann ${file.filename} (${file.mimeType}) nicht als Bild/PDF lesen.`)
    }
    parts.push({ type: 'image_url', image_url: { url: dataUrl(loaded.mimeType, loaded.base64) } })
  }
  return parts
}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

export async function toGeminiParts(text: string, files: InputFile[]): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = []
  for (const file of files) {
    const loaded = await loadInputFile(file)
    if (isPdf(loaded.mimeType) || GEMINI_IMAGE_TYPES.has(loaded.mimeType)) {
      parts.push({ inlineData: { mimeType: loaded.mimeType, data: loaded.base64 } })
      continue
    }
    throw new UnsupportedInputFileError(`Gemini kann ${file.filename} (${file.mimeType}) nicht als Bild/PDF lesen.`)
  }
  parts.push({ text })
  return parts
}

export type XaiResponseContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'high' }
  | { type: 'input_file'; filename: string; file_data: string }

export async function toXaiResponseInput(text: string, files: InputFile[]): Promise<XaiResponseContentPart[]> {
  const skipped: string[] = []
  const parts: XaiResponseContentPart[] = []
  for (const file of files) {
    const loaded = await loadInputFile(file)
    if (XAI_IMAGE_TYPES.has(loaded.mimeType)) {
      parts.push({ type: 'input_image', image_url: dataUrl(loaded.mimeType, loaded.base64), detail: 'high' })
      continue
    }
    skipped.push(`${file.filename} (${file.mimeType})`)
  }
  const note = skipped.length
    ? `\n\n[Grok hat ${skipped.join(', ')} übersprungen — nur JPEG/PNG.]`
    : ''
  parts.unshift({ type: 'input_text', text: text + note })
  return parts
}

export function requestText(messages: { content: string }[]): string {
  return messages.map((m) => m.content).join('\n\n')
}
