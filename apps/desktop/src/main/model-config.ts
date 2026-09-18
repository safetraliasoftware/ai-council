import type { ProviderId } from '@ai-council/shared'
import { DEFAULT_MODELS } from '@ai-council/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

/**
 * Non-secret model preferences, persisted separately from key material
 * (though currently in the same config file - the two writers merge rather
 * than overwrite each other's section).
 */
export class ModelConfig {
  private models: Record<ProviderId, string>

  constructor(
    private filePath: string,
    initial: Partial<Record<ProviderId, string>> = {}
  ) {
    this.models = { ...DEFAULT_MODELS, ...initial }
  }

  static loadFromDisk(filePath: string): ModelConfig {
    const raw = readJsonFileSafe<{ models?: Partial<Record<ProviderId, string>> }>(filePath, {})
    return new ModelConfig(filePath, raw.models ?? {})
  }

  private persist(): void {
    const existing = readJsonFileSafe<Record<string, unknown>>(this.filePath, {})
    writeJsonFileAtomic(this.filePath, { ...existing, models: this.models })
  }

  getModel(provider: ProviderId): string {
    return this.models[provider]
  }

  setModel(provider: ProviderId, model: string): void {
    this.models[provider] = model
    this.persist()
  }

  asRecord(): Record<ProviderId, string> {
    return { ...this.models }
  }
}
