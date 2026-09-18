import { app, ipcMain } from 'electron'
import { checkForUpdates } from './auto-updater'

export function registerUpdatesIpc(): void {
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:getVersion', () => app.getVersion())
}
