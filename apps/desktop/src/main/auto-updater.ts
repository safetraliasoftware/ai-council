import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

let wired = false
let checking = false
let installingUpdate = false

export function isInstallingUpdate(): boolean {
  return installingUpdate
}

export function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE)
}

function wireEvents(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Jetzt neu starten', 'Später'],
      defaultId: 0,
      title: 'Update heruntergeladen',
      message: `Version ${info.version} wurde heruntergeladen. Jetzt neu starten und installieren?`
    }).then((result) => {
      if (result.response === 0) {
        installingUpdate = true
        autoUpdater.quitAndInstall()
      }
    })
  })
  autoUpdater.on('error', (err) => {
    console.error('[auto-updater]', err)
  })
}

/** No-op outside a packaged NSIS install. Portable builds have no installer to apply. */
export function checkForUpdates(): void {
  if (!app.isPackaged || isPortableBuild() || checking) return
  wireEvents()
  checking = true
  autoUpdater.checkForUpdates().catch((err) => console.error('[auto-updater]', err)).finally(() => { checking = false })
}
