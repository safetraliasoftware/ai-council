import { statSync } from 'node:fs'

/** Rejects a working directory that doesn't exist or isn't a directory, before any process starts. */
export function validateWorkingDirectory(path: string): void {
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Error(`Arbeitsverzeichnis existiert nicht: ${path}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`Arbeitsverzeichnis ist kein Ordner: ${path}`)
  }
}
