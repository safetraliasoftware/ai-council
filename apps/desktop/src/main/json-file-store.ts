import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * Shared by every flat JSON-file store in this app (projects, company
 * truth, task graphs, and the secret-store/model-config/backend-config
 * trio sharing config.json). Two concerns every one of them had duplicated
 * ad hoc, and got slightly wrong: distinguishing "no file yet" from "file
 * is corrupted", and writing without a real crash-safety guarantee.
 */

/**
 * Reads and parses a JSON file. "File doesn't exist yet" is normal (first
 * run) and returns `fallback` silently. "File exists but isn't valid JSON"
 * is corruption, not emptiness - caught live: several stores treated a
 * corrupted file exactly like an empty one, so the next write would
 * silently and permanently overwrite whatever was actually still in there.
 * Instead, the corrupted file is renamed aside (preserved for manual
 * recovery, never touched again) and logged, and only then does the caller
 * get `fallback` - later writes create a fresh file rather than clobbering
 * the original.
 */
export function readJsonFileSafe<T>(path: string, fallback: T): T {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    console.error(`[json-file-store] Beschädigte Datei erkannt, wird zur Seite gelegt statt überschrieben: ${path}`, err)
    renameSync(path, `${path}.corrupted-${randomUUID()}`)
    return fallback
  }
}

/**
 * Writes JSON atomically: serialize to a temp file in the same directory,
 * then rename over the target. A crash or power loss mid-write can only
 * ever leave the temp file incomplete, never the real target - `rename` is
 * atomic on the same volume on both Windows and POSIX, so the target file
 * is always either the old complete content or the new complete content,
 * never a half-written mix.
 */
export function writeJsonFileAtomic(path: string, data: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data), 'utf-8')
  renameSync(tmpPath, path)
}

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * Guards every place an id gets interpolated into a filesystem path
 * (project ids under userData/projects/<id>/...). These are always
 * randomUUID()-generated today, never raw user input, so this is
 * defense-in-depth rather than a fix for a reachable exploit - but it's
 * cheap, and it turns "some future caller passes something unexpected"
 * into a clear error instead of a silent path escape.
 */
export function assertSafeId(id: string, label = 'ID'): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Ungültige ${label}: "${id}" enthält unzulässige Zeichen für einen Dateipfad.`)
  }
}
