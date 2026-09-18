import { ipcMain } from 'electron'
import type { CompanyFact, CompanyFactCategory } from './ipc-types'
import { addCompanyFact, deleteCompanyFact, listCompanyFacts } from './company-truth-store'

/** Separate module, same reasoning as projects-ipc.ts - a small, distinct concern with its own wiring. */
export function registerCompanyTruthIpcHandlers(): void {
  ipcMain.handle('companyTruth:list', (): CompanyFact[] => listCompanyFacts())

  ipcMain.handle(
    'companyTruth:add',
    (_e, category: CompanyFactCategory, text: string): CompanyFact => addCompanyFact(category, text)
  )

  ipcMain.handle('companyTruth:delete', (_e, id: string): void => deleteCompanyFact(id))
}
