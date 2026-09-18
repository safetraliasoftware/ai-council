import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { CouncilCallUsage, CouncilRun, CouncilRunEvent } from '@ai-council/council-core'
import type { ProviderId } from '@ai-council/shared'

export type UsageKind = 'compare' | 'team' | 'council' | 'specification' | 'task_graph' | 'change_request' | 'final_review' | 'replanning' | 'coding' | 'execution'
export type UsageCall = Omit<CouncilCallUsage, 'stage' | 'providerId'> & { stage?: string; providerId?: ProviderId; executorId?: string }
export interface UsageRecord {
  runId: string
  kind: UsageKind
  projectId?: string
  workingDirectory?: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  calls: UsageCall[]
}

const connections = new Map<string, Database.Database>()
function database(): Database.Database {
  const directory = app.getPath('userData')
  const path = join(directory, 'usage.db')
  const cached = connections.get(path)
  if (cached) return cached
  mkdirSync(directory, { recursive: true })
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS usage_runs (run_id TEXT PRIMARY KEY, project_id TEXT, started_at INTEGER NOT NULL, record TEXT NOT NULL)')
    // A crashed process cannot truthfully report success or zero usage.
    const rows = db.prepare('SELECT record FROM usage_runs').all() as { record: string }[]
    const save = db.prepare('UPDATE usage_runs SET record = ? WHERE run_id = ?')
    db.transaction(() => {
      for (const row of rows) {
        const record = JSON.parse(row.record) as UsageRecord
        if (record.status !== 'running') continue
        record.status = 'interrupted'
        for (const call of record.calls) if (call.outcome === 'running') call.outcome = 'interrupted'
        save.run(JSON.stringify(record), record.runId)
      }
    })()
    connections.set(path, db)
    return db
  } catch (error) { db.close(); throw error }
}

export function saveUsage(record: UsageRecord): void {
  database().prepare(`INSERT INTO usage_runs VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET project_id=excluded.project_id, started_at=excluded.started_at, record=excluded.record`)
    .run(record.runId, record.projectId ?? null, record.startedAt, JSON.stringify(record))
}

export function listUsage(projectId?: string, limit = 200): UsageRecord[] {
  const count = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 200))
  const rows = projectId
    ? database().prepare('SELECT record FROM usage_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, count)
    : database().prepare('SELECT record FROM usage_runs ORDER BY started_at DESC LIMIT ?').all(count)
  return (rows as { record: string }[]).map(row => JSON.parse(row.record))
}

/** Register before the iterator is consumed: even the first paid call gets a durable start record. */
export function recordCouncilUsage(run: CouncilRun, metadata: Pick<UsageRecord, 'kind' | 'projectId' | 'workingDirectory'>, signal?: AbortSignal): CouncilRun {
  const record: UsageRecord = { ...metadata, runId: run.runId, startedAt: Date.now(), status: 'running', calls: run.usage ?? [] }
  saveUsage(record)
  run.observeUsage?.(() => saveUsage(record))
  async function* events(): AsyncGenerator<CouncilRunEvent> {
    let completed = false
    try {
      for await (const event of run.events) {
        if (event.kind === 'run_done') {
          record.calls = event.usage ?? record.calls
          completed = true
        }
        yield event
      }
    } finally {
      // A Council run (unlike Compare/Team, which have no chair) is designed
      // to tolerate individual participant failures - runCouncil() proceeds
      // to synthesis as long as at least one provider answered, and the
      // chair's synthesized result is what the rest of the UI shows as the
      // run's actual outcome. Requiring every single call to have succeeded
      // (including early, tolerated per-provider failures) mislabeled such a
      // run 'failed' in Usage History even when synthesis produced a valid
      // result. For Compare/Team, no call carries a 'synthesis' stage, so
      // this falls back to the original "every call must succeed" rule.
      const hasSynthesis = record.calls.some(c => c.stage === 'synthesis')
      const succeeded = hasSynthesis
        ? record.calls.some(c => c.stage === 'synthesis' && c.outcome === 'completed')
        : record.calls.length > 0 && record.calls.every(c => c.outcome === 'completed')
      record.status = signal?.aborted ? 'cancelled' : completed && succeeded ? 'completed' : 'failed'
      record.finishedAt = Date.now()
      saveUsage(record)
    }
  }
  return { ...run, events: events() }
}

export function closeUsageStore(): void {
  for (const db of connections.values()) db.close()
  connections.clear()
}
