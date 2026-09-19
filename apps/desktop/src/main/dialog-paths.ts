import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** First existing directory among candidates, for Electron 43+ file dialogs. */
export function firstExistingDir(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

export function parentDir(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const parent = dirname(filePath)
  return parent && parent !== filePath ? parent : undefined
}
