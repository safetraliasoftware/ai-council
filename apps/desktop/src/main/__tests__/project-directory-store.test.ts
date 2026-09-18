import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { mockUserDataDir } = vi.hoisted(() => ({ mockUserDataDir: { current: '' } }))

vi.mock('electron', () => ({
  app: { getPath: () => mockUserDataDir.current }
}))

const { readProjectDirectory, writeProjectDirectory } = await import('../project-directory-store')

describe('project-directory-store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-project-directory-store-'))
    mockUserDataDir.current = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined for a project with no directory set yet', () => {
    expect(readProjectDirectory('never-seen-project')).toBeUndefined()
  })

  it('round-trips a working directory through write and read', () => {
    writeProjectDirectory('proj-1', 'C:\\Projekte\\proj-1')
    expect(readProjectDirectory('proj-1')).toBe('C:\\Projekte\\proj-1')
  })

  it('overwrites the previous directory on a second write', () => {
    writeProjectDirectory('proj-1', 'C:\\Projekte\\alt')
    writeProjectDirectory('proj-1', 'C:\\Projekte\\neu')
    expect(readProjectDirectory('proj-1')).toBe('C:\\Projekte\\neu')
  })
})
