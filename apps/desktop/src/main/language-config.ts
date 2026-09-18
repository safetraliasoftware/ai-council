import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

export type UiLanguage = 'de' | 'en' | 'fr' | 'es'
const DEFAULT_LANGUAGE: UiLanguage = 'de'

interface LanguageConfigFile {
  uiLanguage?: UiLanguage
}

/**
 * Fifth settings class sharing config.json with ElectronSecretStore/
 * ModelConfig/BackendConfig/WorkspaceConfig, same read-merge-write
 * persist() pattern, own top-level key. Default stays 'de' - the app's
 * original, only language - so an unset value behaves exactly like before
 * this setting existed.
 */
export class LanguageConfig {
  private uiLanguage: UiLanguage

  constructor(
    private filePath: string,
    initialLanguage: UiLanguage = DEFAULT_LANGUAGE
  ) {
    this.uiLanguage = initialLanguage
  }

  static loadFromDisk(filePath: string): LanguageConfig {
    const parsed = readJsonFileSafe<LanguageConfigFile>(filePath, {})
    return new LanguageConfig(filePath, parsed.uiLanguage ?? DEFAULT_LANGUAGE)
  }

  getLanguage(): UiLanguage {
    return this.uiLanguage
  }

  setLanguage(language: UiLanguage): void {
    this.uiLanguage = language
    this.persist()
  }

  private persist(): void {
    const existing = readJsonFileSafe<Record<string, unknown>>(this.filePath, {})
    writeJsonFileAtomic(this.filePath, { ...existing, uiLanguage: this.uiLanguage })
  }
}
