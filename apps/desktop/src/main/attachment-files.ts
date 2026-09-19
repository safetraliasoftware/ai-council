import { stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { InputFile } from '@ai-council/shared'
import { MAX_FILE_ATTACHMENTS, MAX_FILE_BYTES, type AttachedArtifact } from './ipc-types'

export { MAX_FILE_ATTACHMENTS, MAX_FILE_BYTES }
export const MAX_INLINE_CHARS = 30000

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.kt', '.xml', '.yml', '.yaml', '.html', '.css', '.log'])

export type ClassifiedKind = 'text' | 'image' | 'pdf' | 'unsupported'

export interface ClassifiedFile {
  kind: ClassifiedKind
  mimeType: string
}

export function classifyFile(filename: string, bytes: Buffer): ClassifiedFile {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === '%PDF') {
    return { kind: 'pdf', mimeType: 'application/pdf' }
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { kind: 'image', mimeType: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg' }
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return { kind: 'image', mimeType: 'image/gif' }
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp' }
  }

  const ext = extname(filename).toLowerCase()
  if (ext === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf' }
  if (ext === '.png') return { kind: 'image', mimeType: 'image/png' }
  if (ext === '.jpg' || ext === '.jpeg') return { kind: 'image', mimeType: 'image/jpeg' }
  if (ext === '.gif') return { kind: 'image', mimeType: 'image/gif' }
  if (ext === '.webp') return { kind: 'image', mimeType: 'image/webp' }

  if (bytes.includes(0)) return { kind: 'unsupported', mimeType: 'application/octet-stream' }

  const mime = ext === '.json' ? 'application/json' : ext === '.csv' ? 'text/csv' : 'text/plain'
  if (TEXT_EXTENSIONS.has(ext) || looksLikeText(bytes)) return { kind: 'text', mimeType: mime }
  return { kind: 'unsupported', mimeType: 'application/octet-stream' }
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let weird = 0
  for (const b of sample) {
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) weird++
  }
  return weird / sample.length < 0.05
}

export function isFileArtifact(artifact: AttachedArtifact): boolean {
  return artifact.kind === 'file'
}

export function withAttachments(prompt: string, attachments: AttachedArtifact[] | undefined): string {
  if (!attachments || attachments.length === 0) return prompt
  const inline = attachments.filter((a) => !isFileArtifact(a) && a.text)
  if (inline.length === 0) return prompt
  const blocks = inline.map((a) => `--- Anhang: ${a.label} ---\n${a.text}`)
  return [prompt, ...blocks].join('\n\n')
}

const allowedAttachmentPaths = new Set<string>()

export function rememberAllowedAttachmentPath(filePath: string): void {
  allowedAttachmentPaths.add(resolve(filePath))
}

export function resetAllowedAttachmentPaths(): void {
  allowedAttachmentPaths.clear()
}

function assertAllowedAttachmentPath(filePath: string, label: string): void {
  if (!allowedAttachmentPaths.has(resolve(filePath))) {
    throw new Error(`Anhang "${label}" stammt nicht aus einem Dateiauswahl-Dialog.`)
  }
}

export async function toInputFiles(attachments: AttachedArtifact[] | undefined): Promise<InputFile[]> {
  if (!attachments || attachments.length === 0) return []
  const files: InputFile[] = []
  for (const artifact of attachments) {
    if (!isFileArtifact(artifact)) continue
    if (!artifact.path || !artifact.mimeType || !artifact.filename) {
      throw new Error(`Anhang "${artifact.label}" ist unvollständig (Pfad/Typ fehlt).`)
    }
    assertAllowedAttachmentPath(artifact.path, artifact.label)
    const info = await stat(artifact.path)
    if (!info.isFile()) throw new Error(`Anhang "${artifact.filename}" ist keine Datei.`)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`Anhang "${artifact.filename}" ist größer als ${MAX_FILE_BYTES / (1024 * 1024)} MB.`)
    }
    files.push({ filename: artifact.filename, mimeType: artifact.mimeType, path: artifact.path })
  }
  if (files.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(`Höchstens ${MAX_FILE_ATTACHMENTS} Dateianhänge.`)
  }
  return files
}
