import type { ProviderId } from '@ai-council/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

/**
 * Per logical provider: use the paid API, the already-authenticated local
 * CLI agent, or resolve automatically at run time (prefer local, fall back
 * to API only if allowed - see participant-factory.ts). Chosen per provider,
 * not as one global switch, so a mixed setup (e.g. Claude local, ChatGPT via
 * API) is directly expressible.
 */
export type ParticipantBackendChoice = 'api' | 'local' | 'auto'

interface BackendConfigFile {
  backends?: Partial<Record<ProviderId, ParticipantBackendChoice>>
  allowPaidApiFallback?: boolean
}

const DEFAULT_BACKENDS: Record<ProviderId, ParticipantBackendChoice> = {
  anthropic: 'auto',
  openai: 'auto',
  gemini: 'auto',
  xai: 'auto'
}

/**
 * Third settings class sharing config.json with ElectronSecretStore/
 * ModelConfig, same read-merge-write persist() pattern, own top-level key.
 * New installations prefer local agents. Explicit saved choices are preserved.
 */
export class BackendConfig {
  private backends: Record<ProviderId, ParticipantBackendChoice>
  private allowPaidApiFallback: boolean

  constructor(
    private filePath: string,
    initialBackends: Partial<Record<ProviderId, ParticipantBackendChoice>> = {},
    initialAllowPaidApiFallback = false
  ) {
    this.backends = { ...DEFAULT_BACKENDS, ...initialBackends }
    this.allowPaidApiFallback = initialAllowPaidApiFallback
  }

  static loadFromDisk(filePath: string): BackendConfig {
    const parsed = readJsonFileSafe<BackendConfigFile>(filePath, {})
    return new BackendConfig(filePath, parsed.backends, parsed.allowPaidApiFallback ?? false)
  }

  getBackend(provider: ProviderId): ParticipantBackendChoice {
    return this.backends[provider]
  }

  setBackend(provider: ProviderId, choice: ParticipantBackendChoice): void {
    this.backends[provider] = choice
    this.persist()
  }

  getAllowPaidApiFallback(): boolean {
    return this.allowPaidApiFallback
  }

  setAllowPaidApiFallback(value: boolean): void {
    this.allowPaidApiFallback = value
    this.persist()
  }

  private persist(): void {
    const existing = readJsonFileSafe<Record<string, unknown>>(this.filePath, {})
    writeJsonFileAtomic(this.filePath, {
      ...existing,
      backends: this.backends,
      allowPaidApiFallback: this.allowPaidApiFallback
    })
  }
}
