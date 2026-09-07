import { ipcMain, BrowserWindow, dialog } from 'electron'
import { ClaudeCodeCliExecutor, OpenAiCodexCliExecutor } from '@ai-council/coding'
import type { CodingExecutor } from '@ai-council/coding'
import type {
  CodingDetectResult,
  CodingExecutorId,
  StartCodingTaskDto
} from './ipc-types'

/**
 * Deliberately separate from ipc.ts (the Council/AIProvider IPC surface).
 * Coding executors are a different kind of thing - agentic runtimes with
 * filesystem/shell access and their own process lifecycle - and keeping
 * their wiring in its own module keeps that boundary visible in the code,
 * not just in the package layout.
 */
export function registerCodingIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const executors: Record<CodingExecutorId, CodingExecutor> = {
    'claude-code-cli': new ClaudeCodeCliExecutor(),
    'openai-codex-cli': new OpenAiCodexCliExecutor()
  }

  function send(win: BrowserWindow, channel: string, payload: unknown): void {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  ipcMain.handle('coding:detect', async (_e, executorId: CodingExecutorId): Promise<CodingDetectResult> => {
    const availability = await executors[executorId].detect()
    return availability
  })

  ipcMain.handle('coding:pickDirectory', async (): Promise<string | undefined> => {
    const win = getWindow()
    if (!win) return undefined
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return result.filePaths[0]
  })

  function forward(win: BrowserWindow, executorId: CodingExecutorId, handle: { taskId: string; events: AsyncIterable<unknown> }): void {
    void (async () => {
      for await (const event of handle.events) {
        send(win, 'coding:event', { executorId, taskId: handle.taskId, event })
      }
    })()
  }

  ipcMain.handle('coding:startTask', (_e, req: StartCodingTaskDto) => {
    const win = getWindow()
    if (!win) return { taskId: '' }

    const executor = executors[req.executorId]
    const handle = executor.startTask({
      prompt: req.prompt,
      workingDirectory: req.workingDirectory,
      permissionTier: req.permissionTier
    })
    forward(win, req.executorId, handle)
    return { taskId: handle.taskId }
  })

  ipcMain.handle('coding:resumeSession', (_e, req: StartCodingTaskDto & { sessionId: string }) => {
    const win = getWindow()
    if (!win) return { taskId: '' }

    const executor = executors[req.executorId]
    if (!executor.resumeSession) return { taskId: '' }
    const handle = executor.resumeSession(req.sessionId, {
      prompt: req.prompt,
      workingDirectory: req.workingDirectory,
      permissionTier: req.permissionTier
    })
    forward(win, req.executorId, handle)
    return { taskId: handle.taskId }
  })

  ipcMain.handle('coding:abort', (_e, req: { executorId: CodingExecutorId; taskId: string }) => {
    executors[req.executorId].abort(req.taskId)
  })
}
