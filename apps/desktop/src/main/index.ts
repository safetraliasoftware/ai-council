import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { ClaudeCodeCliExecutor, OpenAiCodexCliExecutor, GoogleAntigravityCliExecutor, GrokBuildCliExecutor } from '@ai-council/coding'
import type { CodingExecutor } from '@ai-council/coding'
import { registerIpcHandlers } from './ipc'
import { registerCodingIpcHandlers } from './coding-ipc'
import { registerProjectsIpcHandlers } from './projects-ipc'
import { registerArtifactsIpcHandlers } from './artifacts-ipc'
import { registerCompanyTruthIpcHandlers } from './company-truth-ipc'
import { registerProjectSpecIpcHandlers } from './project-spec-ipc'
import { registerTaskGraphIpcHandlers } from './task-graph-ipc'
import { registerTaskGraphExecutionIpcHandlers } from './task-graph-execution-ipc'
import { registerChangeRequestIpcHandlers } from './change-request-ipc'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import { BackendConfig } from './backend-config'
import { WorkspaceConfig } from './workspace-config'
import { LanguageConfig } from './language-config'
import { OnboardingConfig } from './onboarding-config'
import type { CodingExecutorId } from './ipc-types'
import { runCouncil } from '@ai-council/council-core'
import { createParticipantFactory } from './participant-factory'
import { withCompanyTruth } from './company-truth-format'
import { listCompanyFacts } from './company-truth-store'
import { recordCouncilUsage } from './usage-store'
import { installShutdown } from './shutdown'
import { registerUsageIpc } from './usage-ipc'
import { checkForUpdates } from './auto-updater'
import { registerUpdatesIpc } from './updates-ipc'

let mainWindow: BrowserWindow | null = null
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Nur http(s) darf an das Betriebssystem weitergereicht werden - ein
    // Modell-generierter oder anderweitig eingeschleuster Link mit z.B.
    // "file:"/"javascript:" soll nicht kommentarlos vom OS geöffnet werden.
    let protocol: string | undefined
    try {
      protocol = new URL(details.url).protocol
    } catch {
      protocol = undefined
    }
    if (protocol === 'http:' || protocol === 'https:') {
      shell.openExternal(details.url)
    } else {
      console.warn(`[index] Blockierter externer Link mit nicht erlaubtem Protokoll: ${details.url}`)
    }
    return { action: 'deny' }
  })

  // ELECTRON_RENDERER_URL is set only by `electron-vite dev`. Do not read
  // `app.isPackaged` at module load — extra main-process chunks from the
  // provider SDKs used to re-require this file before `app` existed.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (!ownsInstance) return
  const userDataDir = app.getPath('userData')
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true })
  const configPath = join(userDataDir, 'config.json')

  const secretStore = ElectronSecretStore.loadFromDisk(configPath)
  const modelConfig = ModelConfig.loadFromDisk(configPath)
  const backendConfig = BackendConfig.loadFromDisk(configPath)
  const workspaceConfig = WorkspaceConfig.loadFromDisk(configPath)
  const languageConfig = LanguageConfig.loadFromDisk(configPath)
  const onboardingConfig = OnboardingConfig.loadFromDisk(configPath)

  // Constructed once, shared by the Coding-tab IPC surface and by the
  // CouncilParticipant factory below - both use the very same instances,
  // never two separate ones, so task/session state never splits across
  // instances that think they own the same executor.
  const executors: Record<CodingExecutorId, CodingExecutor> = {
    'claude-code-cli': new ClaudeCodeCliExecutor(),
    'openai-codex-cli': new OpenAiCodexCliExecutor(),
    'google-antigravity-cli': new GoogleAntigravityCliExecutor(),
    'grok-build-cli': new GrokBuildCliExecutor()
  }

  registerIpcHandlers(() => mainWindow, secretStore, modelConfig, executors, backendConfig, workspaceConfig, languageConfig, onboardingConfig)
  registerCodingIpcHandlers(() => mainWindow, executors, workspaceConfig)
  registerProjectsIpcHandlers()
  registerArtifactsIpcHandlers(() => mainWindow, workspaceConfig)
  registerCompanyTruthIpcHandlers()
  registerProjectSpecIpcHandlers(() => mainWindow, secretStore, modelConfig, executors, backendConfig)
  registerTaskGraphIpcHandlers(() => mainWindow, secretStore, modelConfig, executors, backendConfig)
  const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)
  const engine = registerTaskGraphExecutionIpcHandlers(() => mainWindow, executors, async (prompt, signal, chairId = 'anthropic', workingDirectory, projectId, kind = 'final_review') => {
    const providers = await buildParticipant.prepareAvailable(workingDirectory)
    const run = recordCouncilUsage(runCouncil({ providers, chairId, request: { messages: [{ role: 'user', content: withCompanyTruth(prompt, listCompanyFacts()) }] }, options: { signal } }),
      { kind, projectId, workingDirectory }, signal)
    let text = ''
    for await (const event of run.events) {
      if (event.kind === 'provider_event' && event.stage === 'synthesis' && event.event.type === 'done') text = event.event.result.text
    }
    if (!text || signal.aborted) throw new Error('Finales Council ohne gültigen Abschluss.')
    return text
  })
  registerChangeRequestIpcHandlers(() => mainWindow, secretStore, modelConfig, executors, backendConfig, engine)
  registerUsageIpc()
  registerUpdatesIpc()
  createWindow()
  installShutdown(() => mainWindow, engine)
  setTimeout(checkForUpdates, 5000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
