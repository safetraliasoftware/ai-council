import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'
import type { ProjectProfile } from './ipc-types'

/**
 * Flat JSON-file store for saved project shortcuts (name + working
 * directory), under Electron's userData dir - same pattern as
 * run-history-store.ts. Small scale (a handful to a few dozen entries for
 * one desktop user), so no database needed.
 */

function storePath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function readAll(): ProjectProfile[] {
  const parsed = readJsonFileSafe<unknown>(storePath(), [])
  return Array.isArray(parsed) ? (parsed as ProjectProfile[]) : []
}

function writeAll(projects: ProjectProfile[]): void {
  writeJsonFileAtomic(storePath(), projects)
}

export function listProjects(): ProjectProfile[] {
  return readAll().sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function saveProject(
  input: Pick<ProjectProfile, 'name' | 'workingDirectory' | 'defaultPermissionTier'>
): ProjectProfile {
  const now = Date.now()
  const project: ProjectProfile = {
    id: randomUUID(),
    name: input.name,
    workingDirectory: input.workingDirectory,
    defaultPermissionTier: input.defaultPermissionTier,
    createdAt: now,
    lastUsedAt: now
  }
  const projects = readAll()
  projects.push(project)
  writeAll(projects)
  return project
}

export function deleteProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id))
}

export function touchProject(id: string): void {
  const projects = readAll()
  const project = projects.find((p) => p.id === id)
  if (project) {
    project.lastUsedAt = Date.now()
    writeAll(projects)
  }
}
