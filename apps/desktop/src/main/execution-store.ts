import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { ProjectExecution, TaskAttempt, TaskGraphSnapshot } from '@ai-council/project-domain'
import { assertSafeId } from './json-file-store'
import { readTaskGraph, writeTaskGraph } from './task-graph-store'
import { loadExecution as loadExecutionFromEventLog } from './engineering-store'

/**
 * Replaces engineering-store.ts's execution-state persistence with real
 * SQLite tables (one file per project) instead of re-embedding the entire
 * ProjectExecution - including every attempt's full raw agent-protocol
 * event history - as a new JSONL line on every single save. Measured live:
 * that pattern had grown one real project's events.jsonl to 29 MB / 3102
 * lines, and re-cloning that size of in-memory state on every 1.5s UI poll
 * (get()'s structuredClone) was pinning the main process at ~100% CPU
 * continuously. engineering-store.ts itself is kept unchanged and still
 * used once per project, below, purely to migrate old data.
 *
 * Specs/ChangeRequests are unaffected - they stay in project-event-log.ts's
 * events.jsonl, which is small (event-sourced replay is genuinely valuable
 * there, and it isn't the measured growth driver).
 */

function projectDir(projectId: string): string {
  assertSafeId(projectId, 'Projekt-ID')
  return join(app.getPath('userData'), 'projects', projectId)
}

function dbPath(projectId: string): string {
  return join(projectDir(projectId), 'execution.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_execution (
  project_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL,
  phase TEXT NOT NULL,
  commands TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  integration TEXT,
  source_branch TEXT,
  source_head TEXT,
  final_verification TEXT,
  final_verdict TEXT,
  release_commit TEXT,
  halt_reason TEXT,
  last_save_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  implementer_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  challenger_id TEXT,
  worktree TEXT,
  verification TEXT NOT NULL,
  reviews TEXT NOT NULL,
  fingerprint TEXT,
  error TEXT,
  commit_hash TEXT,
  context TEXT,
  review_pending INTEGER,
  task_start_commit TEXT,
  integration_worktrees TEXT,
  pending_permission_actions TEXT,
  pending_install_action TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);
CREATE TABLE IF NOT EXISTS attempt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON attempt_events(attempt_id, id);
CREATE TABLE IF NOT EXISTS execution_control (project_id TEXT PRIMARY KEY, budget TEXT);
CREATE TABLE IF NOT EXISTS task_budgets (task_id TEXT PRIMARY KEY, budget TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempt_runtime (attempt_id TEXT PRIMARY KEY, runtime TEXT);
CREATE TABLE IF NOT EXISTS attempt_review_checkpoints (attempt_id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL);
`

const openDbs = new Map<string, Database.Database>()

function openDb(projectId: string): Database.Database {
  const path = dbPath(projectId)
  // Keyed by the resolved path, not the bare projectId - userData is fixed
  // for the app's whole lifetime in production, but this keeps two
  // different userData roots (e.g. per-test temp dirs) from ever colliding
  // on the same cache entry.
  const cached = openDbs.get(path)
  if (cached) return cached
  mkdirSync(projectDir(projectId), { recursive: true })
  let db: Database.Database | undefined
  try {
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA)
  } catch (err) {
    try { db?.close() } catch { /* already unusable */ }
    // Locks, permissions, disk-full and native-module failures are not
    // corruption. Replacing the database here can discard a valid history.
    const code = (err as { code?: string }).code
    if (code !== 'SQLITE_CORRUPT' && code !== 'SQLITE_NOTADB') throw err
    // Same "rename aside, never touch again" recovery as json-file-store.ts's
    // readJsonFileSafe - a corrupted db file must not be silently clobbered.
    console.error(`[execution-store] Beschädigte Datenbank erkannt, wird zur Seite gelegt statt überschrieben: ${path}`, err)
    // new Database() can succeed (open a handle) even when the file isn't a
    // valid db - the failure only surfaces on the pragma/exec call after.
    // On Windows, renaming a file with a still-open handle fails (EBUSY),
    // unlike POSIX - close it first.
    try { db?.close() } catch { /* already unusable */ }
    if (existsSync(path)) renameSync(path, `${path}.corrupted-${randomUUID()}`)
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA)
  }
  openDbs.set(path, db)
  return db
}

/**
 * Runs once per project per app process lifetime, right when its db is
 * first opened - mirrors the restart-recovery ProjectEngine.get() used to
 * do on every single poll (before the summary/detail split below made the
 * UI's 1.5s poll bypass ProjectEngine entirely for performance). Without
 * this, an attempt abandoned mid-run by a real app restart or crash stays
 * stuck at 'running' forever in the new store, since nothing else ever
 * flips it - caught live: after restarting to pick up this very rewrite,
 * a genuinely dead attempt from before the restart still showed as running.
 * Any code path that later calls ProjectEngine.get() for this project will
 * see the same already-interrupted status and its own equivalent check is
 * then a no-op, so this doesn't double-process anything.
 */
function recoverAbandonedAttempts(db: Database.Database, projectId: string): void {
  // archived = 0 is required here: an attempt can be archived (superseded by
  // adoptApprovedPlan()) while still carrying a non-terminal status - without
  // this filter, recovery would sweep up and mutate already-archived,
  // supposedly-final history on every single app restart.
  const abandonedIds = new Set((db.prepare("SELECT id FROM task_attempts WHERE status IN ('running','awaiting_permission','awaiting_install') AND archived = 0").all() as { id: string }[]).map(row => row.id))
  const changed = db.prepare(`
    UPDATE task_attempts SET status = 'interrupted', error = 'Lauf unterbrochen. Alter Worktree bleibt erhalten; ein neuer Versuch verwendet einen neuen Worktree.',
      pending_permission_actions = NULL, pending_install_action = NULL
    WHERE status IN ('running','awaiting_permission','awaiting_install') AND archived = 0
  `).run()
  if (!changed.changes) return
  db.prepare(`UPDATE project_execution SET phase = 'halted', halt_reason = 'Unterbrochener Lauf nach Programmneustart.', updated_at = ? WHERE project_id = ?`)
    .run(Date.now(), projectId)
  const state = readExecution(db, projectId, false)
  if (state) {
    for (const attempt of [...state.attempts, ...(state.archivedAttempts ?? [])]) {
      if (!abandonedIds.has(attempt.id) || !attempt.runtime?.checkpoint || !attempt.worktree) continue
      attempt.status = 'paused'
      attempt.error = 'Lauf nach Programmneustart angehalten. Vorhandenen Arbeitsstand fortsetzen.'
      attempt.runtime.failureKind = 'process'
      attempt.runtime.retryable = true
      if (attempt.runtime.checkpoint === 'review') attempt.reviewPending = true
    }
    writeExecution(db, state, 'RunRecovered')
  }
  const graph = readTaskGraph(projectId)
  if (state && graph) writeTaskGraph(projectId, projectTaskStatuses(state, graph))
}

function isNewlyCreated(projectId: string): boolean {
  return !existsSync(dbPath(projectId))
}

/**
 * One-time, additive migration for projects created before this store
 * existed: reuses engineering-store.ts's (unchanged) event-log reader once
 * to reconstruct the last known ProjectExecution, then writes it into the
 * new tables. The old events.jsonl lines are left untouched - purely
 * additive, no data-loss risk if this needs to be re-run or inspected.
 */
function migrateFromEventLogIfNeeded(projectId: string, db: Database.Database): void {
  const already = db.prepare('SELECT 1 FROM project_execution WHERE project_id = ?').get(projectId)
  if (already) return
  const legacy = loadExecutionFromEventLog(projectId)
  if (!legacy) return
  writeExecution(db, legacy)
}

function writeExecution(db: Database.Database, state: ProjectExecution, reason?: string): void {
  const upsertProject = db.prepare(`
    INSERT INTO project_execution (project_id, run_id, spec_version, phase, commands, max_attempts, integration,
      source_branch, source_head, final_verification, final_verdict, release_commit, halt_reason, last_save_reason, updated_at)
    VALUES (@projectId, @runId, @specVersion, @phase, @commands, @maxAttempts, @integration,
      @sourceBranch, @sourceHead, @finalVerification, @finalVerdict, @releaseCommit, @haltReason, @lastSaveReason, @updatedAt)
    ON CONFLICT(project_id) DO UPDATE SET run_id=excluded.run_id, spec_version=excluded.spec_version, phase=excluded.phase,
      commands=excluded.commands, max_attempts=excluded.max_attempts, integration=excluded.integration,
      source_branch=excluded.source_branch, source_head=excluded.source_head, final_verification=excluded.final_verification,
      final_verdict=excluded.final_verdict, release_commit=excluded.release_commit, halt_reason=excluded.halt_reason,
      last_save_reason=excluded.last_save_reason, updated_at=excluded.updated_at
  `)
  const upsertAttempt = db.prepare(`
    INSERT INTO task_attempts (id, task_id, spec_version, started_at, finished_at, status, implementer_id, reviewer_id,
      challenger_id, worktree, verification, reviews, fingerprint, error, commit_hash, context, review_pending,
      task_start_commit, integration_worktrees, pending_permission_actions, pending_install_action, archived)
    VALUES (@id, @taskId, @specVersion, @startedAt, @finishedAt, @status, @implementerId, @reviewerId,
      @challengerId, @worktree, @verification, @reviews, @fingerprint, @error, @commitHash, @context, @reviewPending,
      @taskStartCommit, @integrationWorktrees, @pendingPermissionActions, @pendingInstallAction, @archived)
    ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, spec_version=excluded.spec_version, started_at=excluded.started_at,
      finished_at=excluded.finished_at, status=excluded.status, implementer_id=excluded.implementer_id,
      reviewer_id=excluded.reviewer_id, challenger_id=excluded.challenger_id, worktree=excluded.worktree,
      verification=excluded.verification, reviews=excluded.reviews, fingerprint=excluded.fingerprint, error=excluded.error,
      commit_hash=excluded.commit_hash, context=excluded.context, review_pending=excluded.review_pending,
      task_start_commit=excluded.task_start_commit, integration_worktrees=excluded.integration_worktrees,
      pending_permission_actions=excluded.pending_permission_actions, pending_install_action=excluded.pending_install_action,
      archived=excluded.archived
  `)

  const run = db.transaction(() => {
    db.prepare('DELETE FROM task_budgets').run()
    const saveTaskBudget = db.prepare('INSERT INTO task_budgets VALUES (?, ?)')
    for (const [taskId, budget] of Object.entries(state.taskBudgets ?? {})) saveTaskBudget.run(taskId, JSON.stringify(budget))
    db.prepare('INSERT INTO execution_control VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET budget=excluded.budget')
      .run(state.projectId, state.budget ? JSON.stringify(state.budget) : null)
    const saveRuntime = db.prepare('INSERT INTO attempt_runtime VALUES (?, ?) ON CONFLICT(attempt_id) DO UPDATE SET runtime=excluded.runtime')
    for (const attempt of [...state.attempts, ...(state.archivedAttempts ?? [])]) saveRuntime.run(attempt.id, attempt.runtime ? JSON.stringify(attempt.runtime) : null)
    const saveReview = db.prepare('INSERT INTO attempt_review_checkpoints VALUES (?, ?) ON CONFLICT(attempt_id) DO UPDATE SET checkpoint=excluded.checkpoint')
    const clearReview = db.prepare('DELETE FROM attempt_review_checkpoints WHERE attempt_id = ?')
    for (const attempt of [...state.attempts, ...(state.archivedAttempts ?? [])]) {
      if (attempt.reviewCheckpoint) saveReview.run(attempt.id, JSON.stringify(attempt.reviewCheckpoint))
      else clearReview.run(attempt.id)
    }
    upsertProject.run({
      projectId: state.projectId, runId: state.runId, specVersion: state.specVersion, phase: state.phase,
      commands: JSON.stringify(state.commands), maxAttempts: state.maxAttempts,
      integration: state.integration ? JSON.stringify(state.integration) : null,
      sourceBranch: state.sourceBranch ?? null, sourceHead: state.sourceHead ?? null,
      finalVerification: state.finalVerification ? JSON.stringify(state.finalVerification) : null,
      finalVerdict: state.finalVerdict ? JSON.stringify(state.finalVerdict) : null,
      releaseCommit: state.releaseCommit ?? null, haltReason: state.haltReason ?? null,
      lastSaveReason: reason ?? null, updatedAt: state.updatedAt
    })
    for (const attempt of state.attempts) upsertAttempt.run(attemptToRow(attempt, false))
    for (const attempt of state.archivedAttempts ?? []) upsertAttempt.run(attemptToRow(attempt, true))
    // Events for a migrated attempt aren't in the row above - insert them
    // once here so a migrated project's Ablaufprotokoll still works.
    const hasEvents = db.prepare('SELECT 1 FROM attempt_events WHERE attempt_id = ? LIMIT 1')
    const insertEvent = db.prepare('INSERT INTO attempt_events (attempt_id, payload) VALUES (?, ?)')
    for (const attempt of [...state.attempts, ...(state.archivedAttempts ?? [])]) {
      if (!attempt.events.length || hasEvents.get(attempt.id)) continue
      for (const event of attempt.events) insertEvent.run(attempt.id, JSON.stringify(event))
    }
  })
  run()
}

function attemptToRow(attempt: TaskAttempt, archived: boolean): Record<string, unknown> {
  return {
    id: attempt.id, taskId: attempt.taskId, specVersion: attempt.specVersion, startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt ?? null, status: attempt.status, implementerId: attempt.implementerId,
    reviewerId: attempt.reviewerId, challengerId: attempt.challengerId ?? null,
    worktree: attempt.worktree ? JSON.stringify(attempt.worktree) : null,
    verification: JSON.stringify(attempt.verification), reviews: JSON.stringify(attempt.reviews),
    fingerprint: attempt.fingerprint ?? null, error: attempt.error ?? null, commitHash: attempt.commit ?? null,
    context: attempt.context ?? null, reviewPending: attempt.reviewPending ? 1 : 0,
    taskStartCommit: attempt.taskStartCommit ?? null,
    integrationWorktrees: attempt.integrationWorktrees ? JSON.stringify(attempt.integrationWorktrees) : null,
    pendingPermissionActions: attempt.pendingPermissionActions ? JSON.stringify(attempt.pendingPermissionActions) : null,
    pendingInstallAction: attempt.pendingInstallAction ? JSON.stringify(attempt.pendingInstallAction) : null,
    archived: archived ? 1 : 0
  }
}

interface AttemptRow {
  id: string; task_id: string; spec_version: number; started_at: number; finished_at: number | null
  status: string; implementer_id: string; reviewer_id: string; challenger_id: string | null
  worktree: string | null; verification: string; reviews: string; fingerprint: string | null
  error: string | null; commit_hash: string | null; context: string | null; review_pending: number | null
  task_start_commit: string | null; integration_worktrees: string | null
  pending_permission_actions: string | null; pending_install_action: string | null; archived: number
}

function rowToAttempt(row: AttemptRow, events: unknown[]): TaskAttempt {
  return {
    id: row.id, taskId: row.task_id, specVersion: row.spec_version, startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined, status: row.status as TaskAttempt['status'],
    implementerId: row.implementer_id, reviewerId: row.reviewer_id, challengerId: row.challenger_id ?? undefined,
    worktree: row.worktree ? JSON.parse(row.worktree) : undefined,
    verification: JSON.parse(row.verification), reviews: JSON.parse(row.reviews),
    fingerprint: row.fingerprint ?? undefined, events, error: row.error ?? undefined,
    commit: row.commit_hash ?? undefined, context: row.context ?? undefined,
    reviewPending: row.review_pending ? true : undefined, taskStartCommit: row.task_start_commit ?? undefined,
    integrationWorktrees: row.integration_worktrees ? JSON.parse(row.integration_worktrees) : undefined,
    pendingPermissionActions: row.pending_permission_actions ? JSON.parse(row.pending_permission_actions) : undefined,
    pendingInstallAction: row.pending_install_action ? JSON.parse(row.pending_install_action) : undefined
  }
}

interface ProjectRow {
  project_id: string; run_id: string; spec_version: number; phase: string; commands: string; max_attempts: number
  integration: string | null; source_branch: string | null; source_head: string | null
  final_verification: string | null; final_verdict: string | null; release_commit: string | null
  halt_reason: string | null; updated_at: number
}

function readExecution(db: Database.Database, projectId: string, includeEvents: boolean): ProjectExecution | undefined {
  const project = db.prepare('SELECT * FROM project_execution WHERE project_id = ?').get(projectId) as ProjectRow | undefined
  if (!project) return undefined
  const rows = db.prepare('SELECT * FROM task_attempts ORDER BY started_at ASC').all() as AttemptRow[]
  const runtimeRows = db.prepare('SELECT attempt_id, runtime FROM attempt_runtime').all() as { attempt_id: string; runtime: string | null }[]
  const runtimes = new Map(runtimeRows.map(row => [row.attempt_id, row.runtime ? JSON.parse(row.runtime) : undefined]))
  const checkpoints = new Map((db.prepare('SELECT attempt_id, checkpoint FROM attempt_review_checkpoints').all() as { attempt_id: string; checkpoint: string }[])
    .map(row => [row.attempt_id, JSON.parse(row.checkpoint)]))
  const control = db.prepare('SELECT budget FROM execution_control WHERE project_id = ?').get(projectId) as { budget: string | null } | undefined
  const taskBudgetRows = db.prepare('SELECT task_id, budget FROM task_budgets').all() as { task_id: string; budget: string }[]
  const eventsByAttempt = new Map<string, unknown[]>()
  if (includeEvents) {
    const eventRows = db.prepare('SELECT attempt_id, payload FROM attempt_events ORDER BY id ASC').all() as { attempt_id: string; payload: string }[]
    for (const row of eventRows) {
      const list = eventsByAttempt.get(row.attempt_id) ?? []
      list.push(JSON.parse(row.payload))
      eventsByAttempt.set(row.attempt_id, list)
    }
  }
  const attempts = rows.filter(r => !r.archived).map(r => rowToAttempt(r, eventsByAttempt.get(r.id) ?? []))
  const archivedAttempts = rows.filter(r => r.archived).map(r => rowToAttempt(r, eventsByAttempt.get(r.id) ?? []))
  for (const attempt of [...attempts, ...archivedAttempts]) {
    attempt.runtime = runtimes.get(attempt.id)
    attempt.reviewCheckpoint = checkpoints.get(attempt.id)
  }
  return {
    budget: control?.budget ? JSON.parse(control.budget) : undefined,
    taskBudgets: taskBudgetRows.length ? Object.fromEntries(taskBudgetRows.map(row => [row.task_id, JSON.parse(row.budget)])) : undefined,
    projectId: project.project_id, runId: project.run_id, specVersion: project.spec_version,
    phase: project.phase as ProjectExecution['phase'], commands: JSON.parse(project.commands),
    maxAttempts: project.max_attempts, attempts, archivedAttempts: archivedAttempts.length ? archivedAttempts : undefined,
    integration: project.integration ? JSON.parse(project.integration) : undefined,
    sourceBranch: project.source_branch ?? undefined, sourceHead: project.source_head ?? undefined,
    finalVerification: project.final_verification ? JSON.parse(project.final_verification) : undefined,
    finalVerdict: project.final_verdict ? JSON.parse(project.final_verdict) : undefined,
    releaseCommit: project.release_commit ?? undefined, haltReason: project.halt_reason ?? undefined,
    updatedAt: project.updated_at
  }
}

const recoveredThisProcess = new Set<string>()

function ensureMigrated(projectId: string): Database.Database {
  const wasNew = isNewlyCreated(projectId)
  const db = openDb(projectId)
  if (wasNew) migrateFromEventLogIfNeeded(projectId, db)
  // Must run after migration (above), not as part of opening the db itself
  // - a project migrating for the first time has an empty task_attempts
  // table until migrateFromEventLogIfNeeded() populates it, so checking
  // for abandoned attempts any earlier than this would silently find
  // nothing to recover. Caught live, right after shipping this rewrite:
  // an attempt genuinely abandoned before the restart still showed
  // 'running' afterward, because this ran before the migrated data existed.
  const key = dbPath(projectId)
  if (!recoveredThisProcess.has(key)) {
    recoveredThisProcess.add(key)
    recoverAbandonedAttempts(db, projectId)
  }
  return db
}

/**
 * Derives each task's status from its latest attempt, same projection
 * engineering-store.ts's saveExecution() always applied before writing
 * task-graph.json. Shared so loadExecution() can defensively re-apply it
 * too (guards the narrow window between writeExecution() and
 * writeTaskGraph() below - a crash there previously left an event log that
 * loadExecution() could replay to recover; here it's cheap enough to just
 * always recompute instead of persisting the projection separately).
 */
function projectTaskStatuses(state: ProjectExecution, graph: TaskGraphSnapshot): TaskGraphSnapshot {
  const projection = structuredClone(graph)
  for (const task of projection.tasks) {
    // 'invalidated'/'needs_revalidation' are only ever set by ProjectEngine
    // explicitly calling the real TaskGraph mutators (see applyChangeRequest)
    // - this generic attempt-status projection has no concept of either and
    // would otherwise silently revert them on the very next unrelated save.
    if (task.status === 'invalidated' || task.status === 'needs_revalidation') continue
    const attempt = [...state.attempts].reverse().find(a => a.taskId === task.id)
    if (!attempt) continue
    task.status = attempt.status === 'accepted' ? 'accepted'
      : attempt.status === 'running' || attempt.status === 'awaiting_permission' || attempt.status === 'awaiting_install' || attempt.status === 'paused' ? 'in_progress'
      : attempt.status === 'review' ? 'review' : attempt.status === 'escalated' ? 'escalated' : 'failed'
  }
  return projection
}

export function loadExecution(projectId: string): ProjectExecution | undefined {
  flushPending(projectId)
  const db = ensureMigrated(projectId)
  const state = readExecution(db, projectId, true)
  if (!state) return undefined
  const current = readTaskGraph(projectId)
  if (current) writeTaskGraph(projectId, projectTaskStatuses(state, current))
  return state
}

export async function saveExecution(state: ProjectExecution, graph: TaskGraphSnapshot, reason: string): Promise<void> {
  const db = ensureMigrated(state.projectId)
  writeExecution(db, state, reason)
  writeTaskGraph(state.projectId, projectTaskStatuses(state, graph))
}

// better-sqlite3 has no async API at all - every call is synchronous and
// blocks the Electron main thread for its duration. project-event-log.ts's
// appendEvent() deliberately queued writes through real async file I/O for
// exactly this reason ("damit ein langer Agent-Lauf den Electron-Main-Thread
// nicht regelmäßig blockiert"). A streamed agent turn can emit hundreds of
// tiny events (one per text/thinking-token chunk, confirmed live via a real
// Ablaufprotokoll) - doing one synchronous INSERT per event reintroduced
// exactly the blocking this was meant to avoid, and was reported live as
// "nothing happens, and Abbrechen doesn't even work" (the main thread was
// too busy handling a burst of individual inserts to promptly service other
// IPC calls). Batched instead: events are buffered in memory per project and
// flushed as one transaction, either on a short timer or once a batch gets
// large - turning many small blocking calls into far fewer, larger ones.
// Keyed by projectId directly (unlike openDbs/recoveredThisProcess, which
// are path-keyed to survive different userData roots across test runs) -
// these two hold only in-memory data and timers, not OS file handles, and
// closeAllForTesting() below always drains and clears both before a test
// ends, so there's no equivalent stale-entry risk to guard against.
const FLUSH_DELAY_MS = 250
const FLUSH_THRESHOLD = 50
const pendingEvents = new Map<string, { attemptId: string; payload: string }[]>()
const flushTimers = new Map<string, NodeJS.Timeout>()

function flushPending(projectId: string): void {
  const timer = flushTimers.get(projectId)
  if (timer) { clearTimeout(timer); flushTimers.delete(projectId) }
  const pending = pendingEvents.get(projectId)
  if (!pending?.length) return
  const db = ensureMigrated(projectId)
  const insert = db.prepare('INSERT INTO attempt_events (attempt_id, payload) VALUES (?, ?)')
  db.transaction((rows: typeof pending) => { for (const row of rows) insert.run(row.attemptId, row.payload) })(pending)
  pendingEvents.delete(projectId)
}

/** Replaces the individual `appendEvent(...'ExecutionAgentEvent'...)` call - buffered and batch-inserted (see flushPending above), never re-persisted in full on a later saveExecution(). */
export async function recordAttemptEvent(projectId: string, attemptId: string, event: unknown): Promise<void> {
  const pending = pendingEvents.get(projectId) ?? []
  pending.push({ attemptId, payload: JSON.stringify(event) })
  pendingEvents.set(projectId, pending)
  if (pending.length >= FLUSH_THRESHOLD) { flushPending(projectId); return }
  if (!flushTimers.has(projectId)) flushTimers.set(projectId, setTimeout(() => {
    try { flushPending(projectId) }
    catch (error) { console.error('Prüfprotokoll konnte noch nicht gespeichert werden; Daten bleiben gepuffert.', error) }
  }, FLUSH_DELAY_MS))
}

/** Same shape as loadExecution() but every attempt's `events` stays empty - for the UI's 1.5s poll, which never needs the full protocol history. */
export function getExecutionSummary(projectId: string): ProjectExecution | undefined {
  flushPending(projectId)
  const db = ensureMigrated(projectId)
  return readExecution(db, projectId, false)
}

/** One attempt's full protocol, in order - fetched on demand only when its Ablaufprotokoll is actually expanded. */
export function getAttemptEvents(projectId: string, attemptId: string): unknown[] {
  flushPending(projectId)
  const db = ensureMigrated(projectId)
  const rows = db.prepare('SELECT payload FROM attempt_events WHERE attempt_id = ? ORDER BY id ASC').all(attemptId) as { payload: string }[]
  return rows.map(r => JSON.parse(r.payload))
}

export function hasExecutionStarted(projectId: string): boolean {
  if (!existsSync(dbPath(projectId))) return false
  const db = ensureMigrated(projectId)
  return !!db.prepare('SELECT 1 FROM project_execution WHERE project_id = ? LIMIT 1').get(projectId)
}

export function hasOpenAttempts(projectId: string): boolean {
  if (!existsSync(dbPath(projectId))) return false
  const db = ensureMigrated(projectId)
  // archived = 0: an archived attempt can still carry a non-terminal status
  // (adoptApprovedPlan() doesn't guard every pause state - see its own
  // fix) and there is no user-facing action that can ever resolve an
  // already-archived attempt, so counting archived rows here would make
  // this return true forever for an affected project.
  return !!db.prepare(
    "SELECT 1 FROM task_attempts WHERE status IN ('running','review','awaiting_permission','awaiting_install','paused') AND archived = 0 LIMIT 1"
  ).get()
}

/**
 * Closes every open connection and clears the cache - not used by the app
 * itself (a real app process only ever opens a project's db once and keeps
 * it for its whole lifetime). Only exists so tests can release Windows file
 * locks (WAL mode keeps -wal/-shm files open) before deleting their temp
 * directory - without this, rmSync in afterEach intermittently fails with
 * EPERM.
 */
export function closeAllForTesting(): void {
  closeExecutionStores()
}

/** Call only after all producers have stopped. A failed flush prevents closing. */
export function closeExecutionStores(): void {
  for (const projectId of [...pendingEvents.keys()]) flushPending(projectId)
  for (const db of openDbs.values()) db.close()
  openDbs.clear()
  recoveredThisProcess.clear()
}
