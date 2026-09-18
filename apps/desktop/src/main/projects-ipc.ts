import { ipcMain } from 'electron'
import { ensureProjectRepository } from '@ai-council/coding'
import type { ProjectProfile } from './ipc-types'
import { deleteProject, listProjects, saveProject, touchProject } from './projects-store'

/** Separate module, same reasoning as coding-ipc.ts vs ipc.ts - a small, distinct concern with its own wiring. */
export function registerProjectsIpcHandlers(): void {
  ipcMain.handle('projects:list', (): ProjectProfile[] => listProjects())

  ipcMain.handle(
    'projects:save',
    async (_e, input: Pick<ProjectProfile, 'name' | 'workingDirectory' | 'defaultPermissionTier'>): Promise<ProjectProfile> => {
      if (!input.name?.trim()) throw new Error('Bitte einen Projektnamen angeben.')
      const workingDirectory = await ensureProjectRepository(input.workingDirectory)
      return saveProject({ ...input, name: input.name.trim(), workingDirectory })
    }
  )

  ipcMain.handle('projects:delete', (_e, id: string): void => deleteProject(id))

  ipcMain.handle('projects:touch', (_e, id: string): void => touchProject(id))
}
