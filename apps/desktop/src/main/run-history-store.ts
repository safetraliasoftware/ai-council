import { app } from 'electron'
import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'
import { join } from 'node:path'
import type { HistoryListEntry, HistoryRunRecord } from './ipc-types'

/**
 * Flat JSON-file store for completed Coding/Workflow runs, under Electron's
 * userData dir. Exists so the same expensive analysis prompt doesn't have
 * to be re-run just to get back to an earlier answer (e.g. picking a
 * different point from a 7-point plan) - each full run (all events, not
 * just the final summary) is kept and can be reopened without calling any
 * executor again. A flat file is enough at this scale (hundreds of runs,
 * one desktop user) - no database needed.
 */

const MAX_RECORDS = 300

function storePath(): string {
  return join(app.getPath('userData'), 'run-history.json')
}

function readAll(): HistoryRunRecord[] {
  const parsed = readJsonFileSafe<unknown>(storePath(), [])
  if (!Array.isArray(parsed)) throw new Error('Ungültiges Format des gespeicherten Verlaufs.')
  return parsed as HistoryRunRecord[]
}

function writeAll(records: HistoryRunRecord[]): void {
  writeJsonFileAtomic(storePath(), records)
}

export function appendRun(record: HistoryRunRecord): void {
  const records = readAll()
  records.push(record)
  // Oldest-first trim once the file grows past MAX_RECORDS - a flat file
  // isn't meant to grow unbounded over months of use.
  const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records
  writeAll(trimmed)
}

function summarize(record: HistoryRunRecord): HistoryListEntry {
  const taskText = record.kind === 'coding' ? record.prompt : record.task
  const summary = taskText.length > 140 ? taskText.slice(0, 140) + '…' : taskText
  const outcome: HistoryListEntry['outcome'] =
    record.kind === 'coding'
      ? record.logs.some((l) => l.kind === 'error')
        ? 'error'
        : 'ok'
      : record.finalResult.noChanges
        ? 'noChanges'
        : record.finalResult.success
          ? 'ok'
          : 'error'
  return {
    id: record.id,
    kind: record.kind,
    workingDirectory: record.workingDirectory,
    summary,
    outcome,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt
  }
}

export function listRuns(kind?: 'coding' | 'workflow'): HistoryListEntry[] {
  const records = readAll()
  const filtered = records
    .filter((r) => !kind || r.kind === kind)
    // A coding record with an empty log has nothing to reopen - it can only
    // exist from before a save-timing bug was fixed (the run itself always
    // produces at least a status/text/done entry). Listing it just means a
    // dead entry the user can click that fills the form but shows no
    // result - hide it instead of surfacing history data with no value.
    .filter((r) => r.kind !== 'coding' || r.logs.length > 0)
  return filtered.map(summarize).sort((a, b) => b.startedAt - a.startedAt)
}

export function getRun(id: string): HistoryRunRecord | undefined {
  return readAll().find((r) => r.id === id)
}

export function getWorkflowWorktree(workflowId: string) {
  const record = readAll().find((r) => r.kind === 'workflow' && r.workflowId === workflowId)
  return record?.kind === 'workflow' ? record.worktree : undefined
}
