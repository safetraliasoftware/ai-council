import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkspaceConfig } from '../workspace-config'

describe('WorkspaceConfig', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-workspace-config-'))
    configPath = join(dir, 'config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('has no workspace root when no file exists yet', () => {
    const config = WorkspaceConfig.loadFromDisk(configPath)
    expect(config.getWorkspaceRoot()).toBeUndefined()
  })

  it('persists a workspace root and reloads it', () => {
    const config = WorkspaceConfig.loadFromDisk(configPath)
    config.setWorkspaceRoot('C:/Users/Andre/Projekte')
    const reloaded = WorkspaceConfig.loadFromDisk(configPath)
    expect(reloaded.getWorkspaceRoot()).toBe('C:/Users/Andre/Projekte')
  })

  it('merges into an existing config.json without clobbering other keys', () => {
    writeFileSync(configPath, JSON.stringify({ models: { anthropic: 'custom-model' } }), 'utf-8')
    const config = WorkspaceConfig.loadFromDisk(configPath)
    config.setWorkspaceRoot('C:/Projekte')

    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(onDisk.models).toEqual({ anthropic: 'custom-model' })
    expect(onDisk.workspaceRoot).toBe('C:/Projekte')
  })
})
