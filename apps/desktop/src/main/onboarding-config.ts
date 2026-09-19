import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'

interface OnboardingConfigFile {
  hasCompletedOnboarding?: boolean
  encryptedKeys?: Record<string, string>
  workspaceRoot?: string
}

/**
 * Sixth settings class sharing config.json, same read-merge-write persist()
 * pattern, own top-level key. loadFromDisk treats a config.json that already
 * has real provider data (encryptedKeys/workspaceRoot) as already onboarded
 * when the flag itself is missing - otherwise every pre-existing install
 * upgrading to this feature would suddenly see the onboarding screen despite
 * already being set up.
 */
export class OnboardingConfig {
  private hasCompletedOnboarding: boolean

  constructor(
    private filePath: string,
    initialValue = false
  ) {
    this.hasCompletedOnboarding = initialValue
  }

  static loadFromDisk(filePath: string): OnboardingConfig {
    const parsed = readJsonFileSafe<OnboardingConfigFile>(filePath, {})
    if (parsed.hasCompletedOnboarding !== undefined) {
      return new OnboardingConfig(filePath, parsed.hasCompletedOnboarding)
    }
    const looksAlreadyConfigured = Boolean(
      (parsed.encryptedKeys && Object.keys(parsed.encryptedKeys).length > 0) || parsed.workspaceRoot
    )
    return new OnboardingConfig(filePath, looksAlreadyConfigured)
  }

  getHasCompletedOnboarding(): boolean {
    return this.hasCompletedOnboarding
  }

  setHasCompletedOnboarding(value: boolean): void {
    this.hasCompletedOnboarding = value
    this.persist()
  }

  private persist(): void {
    const existing = readJsonFileSafe<Record<string, unknown>>(this.filePath, {})
    writeJsonFileAtomic(this.filePath, { ...existing, hasCompletedOnboarding: this.hasCompletedOnboarding })
  }
}
