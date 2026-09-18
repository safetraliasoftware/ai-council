import { applicationRuns } from '../services/run-lifecycle'
import { recordCouncilUsage } from './usage-store'
import { ipcMain, BrowserWindow } from 'electron'
import type { ProviderId } from '@ai-council/shared'
import { runCompare, runTeam, runCouncil } from '@ai-council/council-core'
import type { TeamStep } from '@ai-council/council-core'
import { testAnthropicKey, testOpenAIKey, testGeminiKey } from '@ai-council/providers'
import { ensureProjectRepository } from '@ai-council/coding'
import type { CodingExecutor } from '@ai-council/coding'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import { BackendConfig } from './backend-config'
import { WorkspaceConfig } from './workspace-config'
import { LanguageConfig, type UiLanguage } from './language-config'
import { createParticipantFactory } from './participant-factory'
import { withAttachments } from './attachments'
import { listCompanyFacts } from './company-truth-store'
import { withCompanyTruth } from './company-truth-format'
import type {
  SettingsState,
  TestKeyResult,
  ParallelRunRequestDto,
  TeamRunRequestDto,
  CouncilRunRequestDto,
  AttachedArtifact,
  CodingExecutorId,
  ParticipantBackendChoice
} from './ipc-types'

/**
 * Builds the final prompt string that reaches council-core: Company Truth
 * facts first (foundational context, always included - same as every other
 * Company-Truth caller in this app), then the user's own prompt, then any
 * attached evidence. Shared by all three run handlers so Vergleichen/Team/
 * Council all ground the same way.
 */
function buildContent(prompt: string, attachments: AttachedArtifact[] | undefined): string {
  const withEvidence = withAttachments(prompt, attachments)
  return withCompanyTruth(withEvidence, listCompanyFacts())
}

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig,
  executors: Record<CodingExecutorId, CodingExecutor>,
  backendConfig: BackendConfig,
  workspaceConfig: WorkspaceConfig,
  languageConfig: LanguageConfig
): void {
  const activeRuns = new Map<string, AbortController>()
  const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)

  function getSettingsState(): SettingsState {
    const providers: ProviderId[] = ['anthropic', 'openai', 'gemini']
    const result = {} as SettingsState
    for (const p of providers) {
      result[p] = { hasKey: secretStore.hasKey(p), model: modelConfig.getModel(p), backend: backendConfig.getBackend(p) }
    }
    return result
  }

  async function consumeAndForward(
    win: BrowserWindow,
    runId: string,
    run: { events: AsyncIterable<unknown> }
  ): Promise<void> {
    try {
      for await (const event of run.events) {
        if (!win.isDestroyed()) win.webContents.send('council:event', event)
      }
    } catch (err) {
      // See project-spec-ipc.ts's identical fix for the underlying issue:
      // an uncaught throw here previously crashed this task silently
      // (UnhandledPromiseRejectionWarning) and left the renderer waiting
      // forever for run_done - always send it, even on failure, so
      // "Läuft…" never hangs indefinitely. The real cause is still logged
      // here for debugging.
      console.error(`Council run ${runId} failed unexpectedly:`, err)
      if (!win.isDestroyed()) win.webContents.send('council:event', { kind: 'run_done', runId })
    } finally {
      activeRuns.delete(runId)
    }
  }

  ipcMain.handle('settings:get', () => getSettingsState())

  ipcMain.handle('settings:setKey', (_e, provider: ProviderId, apiKey: string) => {
    secretStore.setKey(provider, apiKey)
    return getSettingsState()
  })

  ipcMain.handle('settings:clearKey', (_e, provider: ProviderId) => {
    secretStore.clearKey(provider)
    return getSettingsState()
  })

  ipcMain.handle('settings:setModel', (_e, provider: ProviderId, model: string) => {
    modelConfig.setModel(provider, model)
    return getSettingsState()
  })

  ipcMain.handle('settings:setBackend', (_e, provider: ProviderId, choice: ParticipantBackendChoice) => {
    backendConfig.setBackend(provider, choice)
    return getSettingsState()
  })

  ipcMain.handle('settings:getAllowPaidApiFallback', () => backendConfig.getAllowPaidApiFallback())

  ipcMain.handle('settings:setAllowPaidApiFallback', (_e, value: boolean) => {
    backendConfig.setAllowPaidApiFallback(value)
  })

  ipcMain.handle('settings:getLanguage', () => languageConfig.getLanguage())

  ipcMain.handle('settings:setLanguage', (_e, language: UiLanguage) => {
    languageConfig.setLanguage(language)
  })

  ipcMain.handle('settings:getWorkspaceRoot', () => workspaceConfig.getWorkspaceRoot())

  ipcMain.handle('settings:setWorkspaceRoot', async (_e, path: string) => {
    try {
      // Reuses the exact same function TaskGraphExecution's per-project
      // "Projektordner einrichten" step calls - git-inits an empty folder
      // (or accepts an already-initialized one idempotently) with the
      // marker commit that makes ensureProjectRepository treat it as an
      // AI-Council-managed workspace root, so any subfolder under it is
      // safe to git-init as its own separate project repo.
      const workspaceRoot = await ensureProjectRepository(path)
      workspaceConfig.setWorkspaceRoot(workspaceRoot)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('settings:testKey', async (_e, provider: ProviderId): Promise<TestKeyResult> => {
    const apiKey = secretStore.getKey(provider)
    if (!apiKey) return { ok: false, error: 'Kein API-Key gespeichert.' }
    const model = modelConfig.getModel(provider)
    try {
      if (provider === 'anthropic') await testAnthropicKey(apiKey, model)
      else if (provider === 'openai') await testOpenAIKey(apiKey, model)
      else await testGeminiKey(apiKey, model)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Building participants and constructing the run (assertUniqueParticipantIds
  // inside runCompare/runCouncil, a bad backend config, etc.) can throw
  // synchronously, before any runId exists to report progress against. Left
  // uncaught, that rejects this handle's promise, which the renderer side
  // never catches (see TaskParallel/TaskTeam/TaskCouncil's run()) - the
  // "Läuft…" button was left stuck forever with no error shown. Caught live
  // for Team mode (duplicate-provider steps). Matches the established
  // fallback already used one line above: an empty runId means "never
  // started", not "started but produced nothing".
  ipcMain.handle('task:runParallel', async (_e, req: ParallelRunRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    try {
      const providers = await buildParticipant.prepare(req.providers)
      const content = buildContent(req.prompt, req.attachments)
      const controller = new AbortController()
      const run = recordCouncilUsage(runCompare(providers, { messages: [{ role: 'user', content }] }, {
        signal: controller.signal
      }), { kind: 'compare' }, controller.signal)
      activeRuns.set(run.runId, controller)
      void applicationRuns.track(() => controller.abort(), () => consumeAndForward(win, run.runId, run)).catch(error => console.error('Lauf konnte nicht abgeschlossen werden:', error))
      return { runId: run.runId }
    } catch (err) {
      console.error('task:runParallel failed to start:', err)
      return { runId: '', error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('task:runTeam', async (_e, req: TeamRunRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    try {
      const participants = await buildParticipant.prepare(req.steps.map(step => step.provider))
      const steps: TeamStep[] = req.steps.map((step, i) => ({ provider: participants[i], roleInstruction: step.roleInstruction }))
      const controller = new AbortController()
      const run = recordCouncilUsage(runTeam(steps, buildContent(req.prompt, req.attachments), {
        signal: controller.signal
      }), { kind: 'team' }, controller.signal)
      activeRuns.set(run.runId, controller)
      void applicationRuns.track(() => controller.abort(), () => consumeAndForward(win, run.runId, run)).catch(error => console.error('Lauf konnte nicht abgeschlossen werden:', error))
      return { runId: run.runId }
    } catch (err) {
      console.error('task:runTeam failed to start:', err)
      return { runId: '', error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('task:runCouncil', async (_e, req: CouncilRunRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    try {
      const providers = await buildParticipant.prepare(req.providers)
      const controller = new AbortController()
      const run = recordCouncilUsage(runCouncil({
        providers,
        chairId: req.chairId,
        request: { messages: [{ role: 'user', content: buildContent(req.prompt, req.attachments) }] },
        options: { signal: controller.signal }
      }), { kind: 'council' }, controller.signal)
      activeRuns.set(run.runId, controller)
      void applicationRuns.track(() => controller.abort(), () => consumeAndForward(win, run.runId, run)).catch(error => console.error('Lauf konnte nicht abgeschlossen werden:', error))
      return { runId: run.runId }
    } catch (err) {
      console.error('task:runCouncil failed to start:', err)
      return { runId: '', error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('task:cancel', (_e, runId: string) => {
    activeRuns.get(runId)?.abort()
  })
}
