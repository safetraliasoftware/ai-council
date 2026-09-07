import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc'
import { registerCodingIpcHandlers } from './coding-ipc'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'

let mainWindow: BrowserWindow | null = null

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
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData')
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true })
  const configPath = join(userDataDir, 'config.json')

  const secretStore = ElectronSecretStore.loadFromDisk(configPath)
  const modelConfig = ModelConfig.loadFromDisk(configPath)

  registerIpcHandlers(() => mainWindow, secretStore, modelConfig)
  registerCodingIpcHandlers(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
