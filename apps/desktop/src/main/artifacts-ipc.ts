import { ipcMain, BrowserWindow, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { captureGitDiff, isGitRepo } from '@ai-council/coding'
import type { AttachedArtifact, CaptureDiffResult } from './ipc-types'
import { MAX_FILE_BYTES, MAX_INLINE_CHARS, classifyFile } from './attachment-files'

/**
 * Lets Vergleichen/Team/Council attach real evidence (a git diff, a local
 * file) instead of only free-text prompts. Deliberately separate from
 * coding-ipc.ts/ipc.ts - this reads from the filesystem/git on behalf of
 * the Council side, a different concern from running a CodingExecutor or
 * an AIProvider. Registered only in apps/desktop (the composition root),
 * which is the one place allowed to import both @ai-council/coding and
 * @ai-council/council-core - council-core itself never sees this module.
 */

function truncate(text: string, label: string): string {
  if (text.length <= MAX_INLINE_CHARS) return text
  return text.slice(0, MAX_INLINE_CHARS) + '\n\n[... gekuerzt, ' + label + ' war laenger als ' + MAX_INLINE_CHARS + ' Zeichen ...]'
}

export function registerArtifactsIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('artifacts:captureDiff', async (_e, workingDirectory: string): Promise<CaptureDiffResult> => {
    if (!workingDirectory.trim()) return { ok: false, error: 'Kein Verzeichnis angegeben.' }
    if (!(await isGitRepo(workingDirectory))) {
      return { ok: false, error: 'Das Verzeichnis ist kein Git-Repository.' }
    }
    const diff = await captureGitDiff(workingDirectory)
    if (!diff.hasChanges) {
      return {
        ok: false,
        noChanges: true,
        error: 'Keine Aenderungen gegenueber dem letzten Commit gefunden.'
      }
    }
    const fileList = diff.files.map((f) => f.path + ' (' + f.status + ')').join(', ')
    const text = [
      'Geaenderte/neue Dateien: ' + fileList,
      diff.diff.trim() || '(kein Inhalt-Diff fuer die gelisteten Dateien)'
    ].join('\n\n')
    const artifact: AttachedArtifact = {
      kind: 'inline-text',
      label: 'Git-Diff: ' + basename(workingDirectory),
      text: truncate(text, 'der Diff')
    }
    return { ok: true, artifact }
  })

  ipcMain.handle('artifacts:readFile', async (): Promise<CaptureDiffResult> => {
    const win = getWindow()
    if (!win) return { ok: false, error: 'Kein Fenster verfuegbar.' }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Text, Bilder, PDF', extensions: ['txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'] },
        { name: 'Alle Dateien', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false }

    const path = result.filePaths[0]
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (bytes.length > MAX_FILE_BYTES) {
      return { ok: false, error: `Datei ist größer als ${MAX_FILE_BYTES / (1024 * 1024)} MB.` }
    }

    const classified = classifyFile(basename(path), bytes)
    if (classified.kind === 'unsupported') {
      return { ok: false, error: 'Nur Text, Bilder (PNG/JPEG/GIF/WebP) oder PDF können angehängt werden.' }
    }
    if (classified.kind === 'text') {
      const artifact: AttachedArtifact = {
        kind: 'inline-text',
        label: 'Datei: ' + basename(path),
        text: truncate(bytes.toString('utf-8'), 'die Datei'),
        filename: basename(path),
        mimeType: classified.mimeType,
        byteLength: bytes.length
      }
      return { ok: true, artifact }
    }

    const artifact: AttachedArtifact = {
      kind: 'file',
      label: basename(path),
      path,
      filename: basename(path),
      mimeType: classified.mimeType,
      byteLength: bytes.length
    }
    return { ok: true, artifact }
  })
}
