import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { ProviderId } from '@ai-council/shared'
import { DEFAULT_MODELS } from '@ai-council/shared'

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
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
        return new ModelConfig(filePath, raw.models ?? {})
      } catch {
        // fall through to defaults on parse error
      }
    }
    return new ModelConfig(filePath, {})
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
      JSON.stringify({ ...existing, models: this.models }, null, 2),
      'utf-8'
    )
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
