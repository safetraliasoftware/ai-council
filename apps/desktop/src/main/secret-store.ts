import { safeStorage } from 'electron'
import type { ProviderId, SecretStore } from '@ai-council/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

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
    const raw = readJsonFileSafe<{ encryptedKeys?: Partial<Record<ProviderId, string>> }>(filePath, {})
    return new ElectronSecretStore(filePath, raw.encryptedKeys ?? {})
  }

  private persist(): void {
    const existing = readJsonFileSafe<Record<string, unknown>>(this.filePath, {})
    writeJsonFileAtomic(this.filePath, { ...existing, encryptedKeys: this.encryptedKeys })
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
