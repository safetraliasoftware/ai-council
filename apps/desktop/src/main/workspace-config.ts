import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

interface WorkspaceConfigFile {
  workspaceRoot?: string
}

/**
 * Fourth settings class sharing config.json with ElectronSecretStore/
 * ModelConfig/BackendConfig, same read-merge-write persist() pattern, own
 * top-level key. Holds the optional default "workshop" folder - a single
 * git repo (see ensureProjectRepository in @ai-council/coding) that new
 * projects can live under as sibling subfolders, instead of each project's
 * first-ever folder accidentally becoming the only usable root (see the
 * "nested inside another Git project" fix in git-worktree.ts).
 */
export class WorkspaceConfig {
  private workspaceRoot: string | undefined

  constructor(
    private filePath: string,
    initialWorkspaceRoot: string | undefined = undefined
  ) {
    this.workspaceRoot = initialWorkspaceRoot
  }

  static loadFromDisk(filePath: string): WorkspaceConfig {
    const parsed = readJsonFileSafe<WorkspaceConfigFile>(filePath, {})
    return new WorkspaceConfig(filePath, parsed.workspaceRoot)
  }

  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot
  }

  setWorkspaceRoot(path: string): void {
    this.workspaceRoot = path
    this.persist()
  }

  private persist(): void {
    const existing = readJsonFileSafe<Record<string, unknown>>(this.filePath, {})
    writeJsonFileAtomic(this.filePath, { ...existing, workspaceRoot: this.workspaceRoot })
  }
}
