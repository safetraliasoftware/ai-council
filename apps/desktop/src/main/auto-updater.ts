import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

let wired = false
let checking = false

function wireEvents(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Jetzt neu starten', 'Später'],
      defaultId: 0,
      title: 'Update heruntergeladen',
      message: `Version ${info.version} wurde heruntergeladen. Jetzt neu starten und installieren?`
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall()
    })
  })
  autoUpdater.on('error', (err) => {
    // A failed update check must never disrupt the running app - this is a
    // background convenience, not something the user is actively waiting on.
    console.error('[auto-updater]', err)
  })
}

/** No-op outside a packaged build - there is no matching published release to check against in dev. */
export function checkForUpdates(): void {
  if (!app.isPackaged || checking) return
  wireEvents()
  checking = true
  autoUpdater.checkForUpdates().catch((err) => console.error('[auto-updater]', err)).finally(() => { checking = false })
}
