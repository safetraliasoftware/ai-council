import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { WorktreeInfo } from '@ai-council/coding'
import { assertSafeId, readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

/** Persist before consuming workflow events; completed actions leave a tombstone. */
export class WorktreeStore {
  constructor(private userData: string, private legacyLookup: (id: string) => WorktreeInfo | undefined) {}

  private file(id: string): string {
    assertSafeId(id, 'Workflow-ID')
    return join(this.userData, 'workflow-worktrees', `${id}.json`)
  }

  get(id: string): WorktreeInfo | undefined {
    const saved = readJsonFileSafe<WorktreeInfo | null | undefined>(this.file(id), undefined)
    if (saved === null) return undefined
    const info = saved ?? this.legacyLookup(id)
    if (!info) return undefined
    const root = join(this.userData, 'worktrees')
    if (typeof info.path !== 'string' || typeof info.sourceRepo !== 'string' ||
        typeof info.branch !== 'string' || !/^ai-council\/[a-zA-Z0-9_-]+$/.test(info.branch) ||
        dirname(resolve(info.path)) !== resolve(root)) {
      throw new Error('Ungültiger gespeicherter Worktree-Pfad.')
    }
    if (!existsSync(join(info.path, '.git'))) return undefined
    if (dirname(realpathSync(info.path)) !== realpathSync(root)) {
      throw new Error('Gespeicherter Worktree liegt außerhalb des Worktree-Verzeichnisses.')
    }
    return info
  }

  set(id: string, info: WorktreeInfo): void {
    writeJsonFileAtomic(this.file(id), info)
  }

  delete(id: string): void {
    writeJsonFileAtomic(this.file(id), null)
  }
}
