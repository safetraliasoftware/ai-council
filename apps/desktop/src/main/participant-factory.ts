import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CouncilParticipant, ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CodingExecutor, ExecutorAvailability } from '@ai-council/coding'
import { isGitRepo } from '@ai-council/coding'
import { toAgentCouncilParticipant, toApiCouncilParticipant } from '@ai-council/council-participants'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import { createProviderFactory } from './provider-factory'
import { BackendConfig } from './backend-config'
import type { CodingExecutorId } from './ipc-types'
import { directoryIssues, findExecutable, PreflightError } from './preflight'
import { applicationRuns } from '../services/run-lifecycle'

const execFileAsync = promisify(execFile)

/**
 * Fixed by construction - there's no scenario where e.g. the Codex CLI plays
 * the "Gemini" council seat, so a per-provider backend choice only ever
 * needs to be api/local/auto, never a free pick of which CLI. Partial
 * because not every provider is guaranteed to have a local agent - an
 * absent entry means that provider is always resolved via the API path,
 * regardless of its stored backend choice (kept even though all four
 * providers currently have one, since a future fifth provider might not).
 */
export const LOGICAL_PROVIDER_LOCAL_AGENT: Partial<Record<ProviderId, CodingExecutorId>> = {
  anthropic: 'claude-code-cli',
  openai: 'openai-codex-cli',
  gemini: 'google-antigravity-cli',
  xai: 'grok-build-cli'
}

// Cached per app session - an 'auto' resolution would otherwise spawn a
// `--version`/`auth status` child process on every single Compare/Team/
// Council/ProjectSpecification run just to decide routing. Invalidated only
// by an explicit user action (see clearDetectCache).
const detectCache = new Map<CodingExecutorId, ExecutorAvailability>()

export function clearDetectCache(): void {
  detectCache.clear()
}

/** Test-only: resets the memoized scratch-directory path (see ensureScratchDirectory below). */
export function clearScratchDirectoryCache(): void {
  scratchDirReady = undefined
}

async function detectCached(executor: CodingExecutor, id: CodingExecutorId): Promise<ExecutorAvailability> {
  const cached = detectCache.get(id)
  if (cached) return cached
  const result = await executor.detect()
  detectCache.set(id, result)
  return result
}

/**
 * Matches the exact event sequence of provider-factory.ts's
 * missingKeyProvider stand-in (start -> error, no done) - council-core's
 * result maps only fill in on `done`, so a stand-in that skipped `start`
 * or reached `done` would behave subtly differently from a real failure.
 */
function unavailableAgentParticipant(id: ProviderId, reason: string): CouncilParticipant {
  return {
    id,
    backend: 'local_agent',
    capabilities: () => ({ streaming: false, tools: false, vision: false }),
    async *generate() {
      yield { type: 'start' as const, runId: randomUUID() }
      yield {
        type: 'error' as const,
        error: { providerId: id, code: 'unknown' as const, message: reason, retryable: false }
      }
    }
  }
}

/**
 * Fallback for a local-agent participant with no real project directory to
 * run in: Compare/Team/Council genuinely have no project-directory concept,
 * and ProjectSpecification/Workflow falls back here too whenever a project
 * has no working directory set yet (see createParticipantFactory's
 * `workingDirectory` parameter below - once one is set, that real directory
 * is used instead, so the council can actually read the project's code).
 *
 * Made into a real (empty) git repo, not left as a plain folder: caught
 * live, the Codex CLI refuses to operate at all in a directory it doesn't
 * consider "trusted" ("Not inside a trusted directory and
 * --skip-git-repo-check was not specified") unless it's a real git repo -
 * initializing one here satisfies that check honestly instead of reaching
 * for an unverified bypass flag, and as a side benefit makes the read-only
 * policy check in toAgentCouncilParticipant (previously dead code for this
 * directory, since captureGitDiff no-ops on a non-repo) actually functional
 * here too.
 */
let scratchDirReady: Promise<string> | undefined

function ensureScratchDirectory(): Promise<string> {
  if (!scratchDirReady) {
    scratchDirReady = (async () => {
      const dir = join(app.getPath('userData'), 'council-scratch')
      await mkdir(dir, { recursive: true })
      if (!(await isGitRepo(dir))) {
        await execFileAsync('git', ['init'], { cwd: dir })
      }
      return dir
    })()
  }
  return scratchDirReady
}

export function createParticipantFactory(
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig,
  executors: Record<CodingExecutorId, CodingExecutor>,
  backendConfig: BackendConfig
): ((id: ProviderId, workingDirectory?: string) => Promise<CouncilParticipant>) & {
  prepare(ids: ProviderId[], workingDirectory?: string): Promise<CouncilParticipant[]>
  prepareAvailable(workingDirectory?: string): Promise<CouncilParticipant[]>
} {
  const buildProvider = createProviderFactory(secretStore, modelConfig)

  // workingDirectory: the real project folder to ground a local-agent
  // participant in (e.g. ProjectSpecification/Workflow once one is set for
  // the project) - omit it for callers with no project concept (Compare/
  // Team/Council), which fall back to the app-owned scratch directory.
  const build = async (id: ProviderId, workingDirectory?: string): Promise<CouncilParticipant> => {
    const choice = backendConfig.getBackend(id)
    const executorId = LOGICAL_PROVIDER_LOCAL_AGENT[id]
    if (!executorId) return toApiCouncilParticipant(buildProvider(id))
    const executor = executors[executorId]

    const useLocal = async (): Promise<CouncilParticipant> =>
      toAgentCouncilParticipant(id, executor, workingDirectory ?? (await ensureScratchDirectory()))

    if (choice === 'local') return useLocal()
    if (choice === 'api') return toApiCouncilParticipant(buildProvider(id))

    // 'auto': prefer local if it looks available. authStatus 'unknown'
    // counts as available - Codex/Antigravity have no real non-interactive
    // login check (verified in packages/coding), so a genuine auth failure
    // surfaces from the first real run instead, matching the philosophy
    // already documented there.
    const availability = await detectCached(executor, executorId)
    if (availability.installed && availability.authStatus !== 'unauthenticated') {
      return useLocal()
    }
    if (secretStore.getKey(id) || backendConfig.getAllowPaidApiFallback()) {
      return toApiCouncilParticipant(buildProvider(id))
    }
    return unavailableAgentParticipant(
      id,
      `Kein lokaler Agent für ${id} verfügbar (nicht installiert oder nicht angemeldet) und kein API-Schlüssel hinterlegt. In den Einstellungen den Agenten einrichten oder einen Key speichern.`
    )
  }
  const prepare = async (ids: ProviderId[], workingDirectory?: string): Promise<CouncilParticipant[]> => {
    applicationRuns.assertRunning()
    const issues: string[] = []
    let needsGit = false
    for (const id of new Set(ids)) {
      if (!Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, id)) { issues.push(`Unbekannter Anbieter: ${id}`); continue }
      const executorId = LOGICAL_PROVIDER_LOCAL_AGENT[id]
      const choice = executorId ? backendConfig.getBackend(id) : 'api'
      let local = choice === 'local'
      if (executorId && choice !== 'api') {
        try {
          const availability = await executors[executorId].detect()
          detectCache.set(executorId, availability)
          local = choice === 'local' || (availability.installed && availability.authStatus !== 'unauthenticated')
          if (local && !availability.installed) issues.push(`${id}: lokalen Agenten installieren; unter Einstellungen → Coding-Agenten prüfen.`)
          else if (local && availability.authStatus === 'unauthenticated') issues.push(`${id}: im lokalen Agenten anmelden und unter Einstellungen erneut prüfen.`)
          if (!local && !secretStore.getKey(id) && !backendConfig.getAllowPaidApiFallback()) {
            issues.push(`${id}: kein angemeldeter lokaler Agent und kein API-Schlüssel. Agenten unter Einstellungen einrichten oder Key speichern.`)
          }
        } catch (error) { issues.push(`${id}: Agentenerkennung fehlgeschlagen (${error instanceof Error ? error.message : String(error)}). Einstellungen prüfen.`); continue }
      }
      if (local) needsGit = true
      else if (choice === 'api' || secretStore.getKey(id) || backendConfig.getAllowPaidApiFallback()) {
        if (!secretStore.getKey(id)) issues.push(`${id}: gültigen API-Schlüssel unter Einstellungen hinterlegen.`)
        if (!modelConfig.getModel(id)?.trim()) issues.push(`${id}: ein Modell unter Einstellungen auswählen.`)
      }
    }
    if (needsGit) {
      const directory = workingDirectory ?? app.getPath('userData')
      issues.push(...await directoryIssues(directory, !workingDirectory, !workingDirectory))
      if (!await findExecutable('git', directory)) issues.push('Git fehlt. Git installieren und PATH prüfen, bevor lokale Council-Agenten starten.')
    }
    if (!ids.length) issues.push('Mindestens einen Anbieter auswählen.')
    if (issues.length) throw new PreflightError(issues)
    applicationRuns.assertRunning()
    const participants = await Promise.all(ids.map(id => build(id, workingDirectory)))
    applicationRuns.assertRunning()
    return participants
  }
  // Final review / replanning have no UI provider picker - they must use
  // whoever is actually configured, including Grok, and must not fail the
  // whole council just because one of the four seats is missing.
  const prepareAvailable = async (workingDirectory?: string): Promise<CouncilParticipant[]> => {
    const ids = Object.keys(PROVIDER_LABELS) as ProviderId[]
    const settled = await Promise.all(ids.map(async (id) => {
      try {
        const [participant] = await prepare([id], workingDirectory)
        return participant
      } catch {
        return undefined
      }
    }))
    const providers = settled.filter((participant): participant is CouncilParticipant => !!participant)
    if (!providers.length) {
      throw new PreflightError(['Kein Council-Teilnehmer verfügbar. Anbieter in den Einstellungen einrichten oder anmelden.'])
    }
    return providers
  }
  return Object.assign(build, { prepare, prepareAvailable })
}
