import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { applicationRuns } from '../services/run-lifecycle'
import { flushProjectEvents } from './project-event-log'
import { closeExecutionStores } from './execution-store'
import { closeUsageStore } from './usage-store'
import { stopRemainingProcesses } from '@ai-council/coding'
import { isInstallingUpdate } from './auto-updater'

export function installShutdown(getWindow: () => BrowserWindow | null, engine: { shutdown(): Promise<void> }): void {
  let finished = false
  let pending: Promise<void> | undefined
  let draining: Promise<void> | undefined
  const drain = async () => {
    const results = await Promise.allSettled([applicationRuns.shutdown(), engine.shutdown()])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Laufende Aufträge konnten nicht vollständig gesichert werden.')
    await stopRemainingProcesses()
    await flushProjectEvents()
    closeExecutionStores()
    closeUsageStore()
  }
  app.on('before-quit', event => {
    if (finished || isInstallingUpdate()) return
    event.preventDefault()
    if (pending) return
    const win = getWindow()
    win?.setTitle('AI Council – Aufträge werden angehalten und gespeichert …')
    draining ??= drain().catch(error => { draining = undefined; throw error })
    const work = draining
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Ein Auftrag reagiert noch nicht auf den Abbruch. Das Fenster bleibt offen; bitte kurz warten und erneut schließen.')), 20000)
        })])
        finished = true
        app.quit()
      } catch (error) {
        win?.setTitle('AI Council – Beenden noch nicht abgeschlossen')
        dialog.showErrorBox('Programm bleibt geöffnet', `Aufträge wurden angehalten. Der sichere Abschluss ist noch nicht bestätigt.\n${error instanceof Error ? error.message : String(error)}`)
      } finally { if (timer) clearTimeout(timer); pending = undefined }
    })()
  })
  // Keep the renderer alive until buffered events and task state are durable.
  // A window created later than this call (e.g. via 'activate' on macOS,
  // after the app stayed alive with zero windows) must get the same
  // interception - otherwise closing it bypasses the graceful app.quit()
  // drain entirely. Attach to the window that exists now, plus every one
  // Electron creates from here on.
  const attachCloseGuard = (win: BrowserWindow): void => {
    win.on('close', event => {
      if (!finished && !isInstallingUpdate()) { event.preventDefault(); app.quit() }
    })
  }
  const initialWindow = getWindow()
  if (initialWindow) attachCloseGuard(initialWindow)
  app.on('browser-window-created', (_event, win) => attachCloseGuard(win))
}
