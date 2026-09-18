import { app } from 'electron'
import { join } from 'node:path'
import { assertSafeId, readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

/**
 * Flat per-project JSON file, same read-modify-write pattern as
 * task-graph-store.ts, sibling file under the same userData/projects/<id>/
 * directory. Deliberately its own tiny store, not a field on
 * ProjectSpecification (its event-sourced log is already hardened and
 * shouldn't be touched for an unrelated field - the same reasoning
 * TaskGraphSnapshot.workingDirectory's own doc comment already uses one
 * layer later) and not a field on TaskGraphSnapshot either (a working
 * directory is a property of the project - the stable id - not of any one
 * spec/taskgraph version; letting the user pick it before either exists
 * needs a store that doesn't require either to exist yet).
 */

function projectDir(projectId: string): string {
  assertSafeId(projectId, 'Projekt-ID')
  return join(app.getPath('userData'), 'projects', projectId)
}

function storePath(projectId: string): string {
  return join(projectDir(projectId), 'directory.json')
}

export function readProjectDirectory(projectId: string): string | undefined {
  return readJsonFileSafe<{ workingDirectory?: string }>(storePath(projectId), {}).workingDirectory
}

export function writeProjectDirectory(projectId: string, workingDirectory: string): void {
  writeJsonFileAtomic(storePath(projectId), { workingDirectory })
}
