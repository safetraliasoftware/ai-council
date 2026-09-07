import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AIProvider, ProviderId } from '@ai-council/shared'
import { runCompare, runTeam, runCouncil } from '@ai-council/council-core'
import type { TeamStep } from '@ai-council/council-core'
import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  testAnthropicKey,
  testOpenAIKey,
  testGeminiKey
} from '@ai-council/providers'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import type {
  SettingsState,
  TestKeyResult,
  ParallelRunRequestDto,
  TeamRunRequestDto,
  CouncilRunRequestDto
} from './ipc-types'

/**
 * Returns a stand-in AIProvider that immediately reports a config error.
 * Keeps "no key configured" flowing through the same ProviderEvent
 * vocabulary as a real failure, instead of a second ad-hoc error channel.
 */
function missingKeyProvider(id: ProviderId): AIProvider {
  return {
    id,
    capabilities: () => ({ streaming: false, tools: false, vision: false }),
    async *generate() {
      yield { type: 'start' as const, runId: randomUUID() }
      yield {
        type: 'error' as const,
        error: {
          providerId: id,
          code: 'auth' as const,
          message: 'Kein API-Key für diesen Anbieter hinterlegt.',
          retryable: false
        }
      }
    }
  }
}

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig
): void {
  const activeRuns = new Map<string, AbortController>()

  function buildProvider(id: ProviderId): AIProvider {
    const apiKey = secretStore.getKey(id)
    const model = modelConfig.getModel(id)
    if (!apiKey) return missingKeyProvider(id)
    switch (id) {
      case 'anthropic':
        return new AnthropicProvider({ apiKey, model })
      case 'openai':
        return new OpenAIProvider({ apiKey, model })
      case 'gemini':
        return new GeminiProvider({ apiKey, model })
    }
  }

  function getSettingsState(): SettingsState {
    const providers: ProviderId[] = ['anthropic', 'openai', 'gemini']
    const result = {} as SettingsState
    for (const p of providers) {
      result[p] = { hasKey: secretStore.hasKey(p), model: modelConfig.getModel(p) }
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

  ipcMain.handle('task:runParallel', (_e, req: ParallelRunRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    const providers = req.providers.map(buildProvider)
    const controller = new AbortController()
    const run = runCompare(providers, { messages: [{ role: 'user', content: req.prompt }] }, {
      signal: controller.signal
    })
    activeRuns.set(run.runId, controller)
    void consumeAndForward(win, run.runId, run)
    return { runId: run.runId }
  })

  ipcMain.handle('task:runTeam', (_e, req: TeamRunRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    const steps: TeamStep[] = req.steps.map((s) => ({
      provider: buildProvider(s.provider),
      roleInstruction: s.roleInstruction
    }))
    const controller = new AbortController()
    const run = runTeam(steps, req.prompt, { signal: controller.signal })
    activeRuns.set(run.runId, controller)
    void consumeAndForward(win, run.runId, run)
    return { runId: run.runId }
  })

  ipcMain.handle('task:runCouncil', (_e, req: CouncilRunRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    const providers = req.providers.map(buildProvider)
    const controller = new AbortController()
    const run = runCouncil({
      providers,
      chairId: req.chairId,
      request: { messages: [{ role: 'user', content: req.prompt }] },
      options: { signal: controller.signal }
    })
    activeRuns.set(run.runId, controller)
    void consumeAndForward(win, run.runId, run)
    return { runId: run.runId }
  })

  ipcMain.handle('task:cancel', (_e, runId: string) => {
    activeRuns.get(runId)?.abort()
    activeRuns.delete(runId)
  })
}
