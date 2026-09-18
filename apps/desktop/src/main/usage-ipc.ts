import { ipcMain } from 'electron'
import { listUsage } from './usage-store'
import type { UsageRecord } from './usage-store'
import { listProjectIds } from './project-event-log'
import { getExecutionSummary, hasExecutionStarted } from './execution-store'
import { assertSafeId } from './json-file-store'

/** Execution calls already have a durable ledger. Read it instead of counting local Council calls twice. */
export function usageHistory(projectId?: string): UsageRecord[] {
  if (projectId !== undefined) assertSafeId(projectId, 'Projekt-ID')
  const records = listUsage(projectId)
  for (const id of projectId ? [projectId] : listProjectIds()) {
    if (!hasExecutionStarted(id)) continue
    const state = getExecutionSummary(id)
    if (!state) continue
    for (const attempt of [...state.attempts, ...(state.archivedAttempts ?? [])]) {
      const calls = attempt.runtime?.calls
      if (!calls?.length) continue
      records.push({ runId: attempt.id, kind: 'execution', projectId: id, workingDirectory: attempt.worktree?.path,
        startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
        status: ['review', 'accepted'].includes(attempt.status) ? 'completed' : attempt.status === 'running' ? 'running' : attempt.status === 'interrupted' ? 'interrupted' : attempt.runtime?.failureKind === 'cancelled' ? 'cancelled' : 'failed',
        calls: calls.map(call => ({ callId: call.id, executorId: call.executorId, backend: 'local_agent', stage: call.stage,
          startedAt: call.startedAt, durationMs: call.finishedAt ? call.finishedAt - call.startedAt : 0,
          inputChars: call.inputChars, outputChars: call.outputChars, inputTokens: call.inputTokens, outputTokens: call.outputTokens,
          costUsd: call.costUsd, outcome: call.outcome === 'running' && attempt.status !== 'running' ? 'interrupted' : call.outcome }))
      })
    }
  }
  return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, 200)
}

export function registerUsageIpc(): void {
  ipcMain.handle('usage:list', (_event, projectId?: string) => usageHistory(projectId))
}
