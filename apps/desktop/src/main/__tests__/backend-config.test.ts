import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BackendConfig } from '../backend-config'

describe('BackendConfig', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-backend-config-'))
    configPath = join(dir, 'config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('defaults every provider to "auto" when no file exists yet', () => {
    const config = BackendConfig.loadFromDisk(configPath)
    expect(config.getBackend('anthropic')).toBe('auto')
    expect(config.getBackend('openai')).toBe('auto')
    expect(config.getBackend('gemini')).toBe('auto')
    expect(config.getBackend('xai')).toBe('auto')
    expect(config.getAllowPaidApiFallback()).toBe(false)
  })

  it('persists a backend choice and reloads it', () => {
    const config = BackendConfig.loadFromDisk(configPath)
    config.setBackend('anthropic', 'local')
    const reloaded = BackendConfig.loadFromDisk(configPath)
    expect(reloaded.getBackend('anthropic')).toBe('local')
    expect(reloaded.getBackend('openai')).toBe('auto')
  })

  it('persists allowPaidApiFallback and reloads it', () => {
    const config = BackendConfig.loadFromDisk(configPath)
    config.setAllowPaidApiFallback(true)
    const reloaded = BackendConfig.loadFromDisk(configPath)
    expect(reloaded.getAllowPaidApiFallback()).toBe(true)
  })

  it('merges into an existing config.json without clobbering other keys', () => {
    writeFileSync(configPath, JSON.stringify({ models: { anthropic: 'custom-model' } }), 'utf-8')
    const config = BackendConfig.loadFromDisk(configPath)
    config.setBackend('gemini', 'auto')

    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(onDisk.models).toEqual({ anthropic: 'custom-model' })
    expect(onDisk.backends.gemini).toBe('auto')
  })
})
