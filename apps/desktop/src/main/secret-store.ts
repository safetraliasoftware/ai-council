import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { ProviderId, SecretStore } from '@ai-council/shared'

/**
 * The ONLY class in this codebase allowed to touch real API key material.
 * Lives exclusively in the Electron main process. Nothing outside this file
 * ever sees a decrypted key except a provider adapter instance constructed
 * right here in main - the key never crosses an IPC boundary, and the
 * renderer only ever receives `hasKey: boolean`.
 */
export class ElectronSecretStore implements SecretStore {
  private encryptedKeys: Partial<Record<ProviderId, string>> = {}

  constructor(
    private filePath: string,
    initial: Partial<Record<ProviderId, string>> = {}
  ) {
    this.encryptedKeys = initial
  }

  static loadFromDisk(filePath: string): ElectronSecretStore {
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
        return new ElectronSecretStore(filePath, raw.encryptedKeys ?? {})
      } catch {
        // fall through to empty store on parse error
      }
    }
    return new ElectronSecretStore(filePath, {})
  }

  private persist(): void {
    let existing: Record<string, unknown> = {}
    if (existsSync(this.filePath)) {
      try {
        existing = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      } catch {
        existing = {}
      }
    }
    writeFileSync(
      this.filePath,
      JSON.stringify({ ...existing, encryptedKeys: this.encryptedKeys }, null, 2),
      'utf-8'
    )
  }

  hasKey(provider: ProviderId): boolean {
    return Boolean(this.encryptedKeys[provider])
  }

  getKey(provider: ProviderId): string | undefined {
    const stored = this.encryptedKeys[provider]
    if (!stored) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return undefined
    }
  }

  setKey(provider: ProviderId, apiKey: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Verschlüsselter Speicher ist auf diesem System nicht verfügbar. API-Key konnte nicht sicher gespeichert werden.'
      )
    }
    this.encryptedKeys[provider] = safeStorage.encryptString(apiKey).toString('base64')
    this.persist()
  }

  clearKey(provider: ProviderId): void {
    delete this.encryptedKeys[provider]
    this.persist()
  }
}
