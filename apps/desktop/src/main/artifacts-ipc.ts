import { ipcMain, BrowserWindow, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { captureGitDiff, isGitRepo } from '@ai-council/coding'
import type { AttachedArtifact, CaptureDiffResult } from './ipc-types'

/**
 * Lets Vergleichen/Team/Council attach real evidence (a git diff, a local
 * file) instead of only free-text prompts. Deliberately separate from
 * coding-ipc.ts/ipc.ts - this reads from the filesystem/git on behalf of
 * the Council side, a different concern from running a CodingExecutor or
 * an AIProvider. Registered only in apps/desktop (the composition root),
 * which is the one place allowed to import both @ai-council/coding and
 * @ai-council/council-core - council-core itself never sees this module.
 */

const MAX_ARTIFACT_CHARS = 30000
const NULL_BYTE = String.fromCharCode(0)

function truncate(text: string, label: string): string {
  if (text.length <= MAX_ARTIFACT_CHARS) return text
  return text.slice(0, MAX_ARTIFACT_CHARS) + '\n\n[... gekuerzt, ' + label + ' war laenger als ' + MAX_ARTIFACT_CHARS + ' Zeichen ...]'
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
      label: 'Git-Diff: ' + basename(workingDirectory),
      text: truncate(text, 'der Diff')
    }
    return { ok: true, artifact }
  })

  ipcMain.handle('artifacts:readFile', async (): Promise<CaptureDiffResult> => {
    const win = getWindow()
    if (!win) return { ok: false, error: 'Kein Fenster verfuegbar.' }
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return { ok: false }

    const path = result.filePaths[0]
    let content: string
    try {
      content = await readFile(path, 'utf-8')
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    // A null byte is a reliable enough signal this isn't text (utf-8 decoding
    // of arbitrary binary data doesn't throw, it just produces garbage).
    if (content.includes(NULL_BYTE)) {
      return { ok: false, error: 'Datei sieht nach Binaerinhalt aus, nicht nach Text.' }
    }

    const artifact: AttachedArtifact = {
      label: 'Datei: ' + basename(path),
      text: truncate(content, 'die Datei')
    }
    return { ok: true, artifact }
  })
}
