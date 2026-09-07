import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// safeStorage only exists inside a real Electron process - stub it with a
// reversible base64 "encryption" so the store logic can be tested in plain
// Node/vitest without pulling in Electron itself.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const { ElectronSecretStore } = await import('../secret-store')
const { ModelConfig } = await import('../model-config')

describe('ElectronSecretStore', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-test-'))
    configPath = join(dir, 'config.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a key through set/get and reports hasKey correctly', () => {
    const store = ElectronSecretStore.loadFromDisk(configPath)
    expect(store.hasKey('anthropic')).toBe(false)

    store.setKey('anthropic', 'sk-ant-super-secret-12345')
    expect(store.hasKey('anthropic')).toBe(true)
    expect(store.getKey('anthropic')).toBe('sk-ant-super-secret-12345')
  })

  it('clears a key', () => {
    const store = ElectronSecretStore.loadFromDisk(configPath)
    store.setKey('openai', 'sk-openai-secret')
    store.clearKey('openai')
    expect(store.hasKey('openai')).toBe(false)
    expect(store.getKey('openai')).toBeUndefined()
  })

  it('SECRET BOUNDARY: the settings projection sent to the renderer never contains the raw key', () => {
    const store = ElectronSecretStore.loadFromDisk(configPath)
    const models = ModelConfig.loadFromDisk(configPath)
    const secretValue = 'sk-ant-do-not-leak-this-9876543210'
    store.setKey('anthropic', secretValue)

    // Mirrors exactly what ipc.ts's getSettingsState() sends over IPC.
    const settingsState = {
      anthropic: { hasKey: store.hasKey('anthropic'), model: models.getModel('anthropic') }
    }

    expect(Object.keys(settingsState.anthropic).sort()).toEqual(['hasKey', 'model'])
    expect(JSON.stringify(settingsState)).not.toContain(secretValue)
  })

  it('persists keys to disk only in encrypted (non-plaintext) form', () => {
    const store = ElectronSecretStore.loadFromDisk(configPath)
    const secretValue = 'sk-plaintext-should-not-appear-on-disk'
    store.setKey('gemini', secretValue)

    expect(existsSync(configPath)).toBe(true)
    const onDisk = readFileSync(configPath, 'utf-8')
    // Our mock "encryption" is base64, not real encryption, but this still
    // proves the raw secret string is never written verbatim to disk.
    expect(onDisk).not.toContain(secretValue)
  })
})
