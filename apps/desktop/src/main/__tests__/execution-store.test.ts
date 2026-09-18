import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { ProjectExecution, TaskGraphSnapshot } from '@ai-council/project-domain'
const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
import {
  saveExecution, loadExecution, recordAttemptEvent, getExecutionSummary, getAttemptEvents,
  hasExecutionStarted, hasOpenAttempts, closeAllForTesting
} from '../execution-store'
import { saveExecution as saveExecutionLegacy } from '../engineering-store'
import { readTaskGraph } from '../task-graph-store'

beforeEach(() => { state.dir = mkdtempSync(join(tmpdir(), 'council-execution-db-')) })
afterEach(() => { closeAllForTesting(); rmSync(state.dir, { recursive: true, force: true }) })

function fixtureGraph(): TaskGraphSnapshot {
  return { projectId: 'p', specVersion: 1, status: 'human_approved', chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0,
    tasks: [{ id: 't', title: 'task', description: '', specVersion: 1, status: 'pending', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } }] }
}

it('persists paused checkpoints, budgets and measured usage in summary reads across restart', async () => {
  const execution = fixtureExecution('paused')
  execution.budget = { maxCalls: 6, maxCorrections: 2, maxActiveMs: 600000 }
  execution.taskBudgets = { t: { maxCalls: 12, maxCorrections: 4, maxActiveMs: 3600000 } }
  execution.attempts[0].runtime = { activeMs: 1234, corrections: 1, failureKind: 'quota', retryable: true, checkpoint: 'fix', calls: [
    { id: 'call', executorId: 'one', stage: 'fix', startedAt: 10, finishedAt: 40, outcome: 'failed', inputChars: 50, outputChars: 8, inputTokens: 12 }
  ] }
  execution.attempts[0].reviewCheckpoint = { key: 'same-evidence', results: { two: { verdict: 'pass', findings: [] } } }
  await saveExecution(execution, fixtureGraph(), 'TaskPaused')
  closeAllForTesting()
  const restored = getExecutionSummary('p')
  if (!restored) throw new Error('Persisted execution missing after restart')
  expect(restored.budget).toEqual(execution.budget)
  expect(restored.taskBudgets).toEqual(execution.taskBudgets)
  expect(restored.attempts[0].status).toBe('paused')
  expect(restored.attempts[0].runtime).toEqual(execution.attempts[0].runtime)
  expect(restored.attempts[0].reviewCheckpoint).toEqual(execution.attempts[0].reviewCheckpoint)
  expect(hasOpenAttempts('p')).toBe(true)
})

it('removes a persisted individual-review checkpoint once the review cycle completes', async () => {
  const execution = fixtureExecution('paused')
  execution.attempts[0].reviewCheckpoint = { key: 'evidence', results: { two: { verdict: 'pass', findings: [] } } }
  await saveExecution(execution, fixtureGraph(), 'IndividualReviewCompleted')
  execution.attempts[0].reviewCheckpoint = undefined
  await saveExecution(execution, fixtureGraph(), 'ReviewCompleted')
  closeAllForTesting()
  expect(loadExecution('p')?.attempts[0].reviewCheckpoint).toBeUndefined()
})

it.each(['SQLITE_BUSY', 'SQLITE_READONLY', 'SQLITE_FULL'])('preserves the existing database after %s instead of resetting it', async code => {
  await saveExecution(fixtureExecution('review'), fixtureGraph(), 'TaskReady')
  closeAllForTesting()
  const failure = Object.assign(new Error('temporary database failure'), { code })
  const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(() => { throw failure })
  try { expect(() => loadExecution('p')).toThrow('temporary database failure') }
  finally { pragma.mockRestore() }
  expect(readdirSync(join(state.dir, 'projects', 'p')).some(name => name.includes('.corrupted-'))).toBe(false)
  expect(loadExecution('p')?.attempts[0]).toMatchObject({ id: 'a', status: 'review' })
})
function fixtureExecution(status: ProjectExecution['attempts'][number]['status'] = 'running'): ProjectExecution {
  return { projectId: 'p', runId: 'r', specVersion: 1, phase: 'execution', commands: [{ executable: 'npm', args: ['test'], timeoutMs: 1000 }],
    maxAttempts: 3, updatedAt: 0,
    attempts: [{ id: 'a', taskId: 't', specVersion: 1, startedAt: 0, status, implementerId: 'one', reviewerId: 'two',
      challengerId: 'three', verification: [], reviews: [], events: [], reviewPending: true, error: undefined }] }
}

it('round-trips an attempt through save/load including nested worktree/verification/review fields', async () => {
  const execution = fixtureExecution('review')
  execution.attempts[0].worktree = { path: 'C:/wt', branch: 'ai-council/a', sourceRepo: 'C:/repo' }
  execution.attempts[0].verification = [{ command: { executable: 'npm', args: ['test'], timeoutMs: 1000 }, exitCode: 0, stdout: 'ok', stderr: '',
    durationMs: 5, success: true, timedOut: false, aborted: false, killConfirmed: true }]
  execution.attempts[0].reviews = [{ verdict: 'pass', findings: [] }]
  await saveExecution(execution, fixtureGraph(), 'TaskStarted')
  const restored = loadExecution('p')!
  expect(restored.attempts[0]).toMatchObject({
    id: 'a', taskId: 't', status: 'review', worktree: execution.attempts[0].worktree,
    verification: execution.attempts[0].verification, reviews: execution.attempts[0].reviews, reviewPending: true
  })
  expect(restored.commands).toEqual(execution.commands)
})

it('projects task status from the latest attempt onto task-graph.json, same as before', async () => {
  await saveExecution(fixtureExecution('accepted'), fixtureGraph(), 'TaskAccepted')
  expect(readTaskGraph('p')?.tasks[0].status).toBe('accepted')
})

it('does not revert an invalidated task back to attempt-derived status on a later save', async () => {
  const graph = fixtureGraph()
  graph.tasks[0].status = 'invalidated'
  await saveExecution(fixtureExecution('failed'), graph, 'Unrelated')
  expect(readTaskGraph('p')?.tasks[0].status).toBe('invalidated')
})

it('recordAttemptEvent appends events that loadExecution reconstructs in order, but getExecutionSummary omits them', async () => {
  await saveExecution(fixtureExecution(), fixtureGraph(), 'TaskStarted')
  await recordAttemptEvent('p', 'a', { type: 'text', text: 'first' })
  await recordAttemptEvent('p', 'a', { type: 'text', text: 'second' })
  const full = loadExecution('p')!
  expect(full.attempts[0].events).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])
  const summary = getExecutionSummary('p')!
  expect(summary.attempts[0].events).toEqual([])
})

it('REGRESSION (synchrones Insert pro Event blockierte den Main-Thread): a large burst of events (spanning multiple batched flushes) is still fully and correctly persisted, in order, none lost or duplicated', async () => {
  await saveExecution(fixtureExecution(), fixtureGraph(), 'TaskStarted')
  const count = 120 // comfortably more than FLUSH_THRESHOLD, forcing >=2 threshold-triggered flushes plus a final one
  for (let i = 0; i < count; i++) await recordAttemptEvent('p', 'a', { n: i })
  const events = getAttemptEvents('p', 'a')
  expect(events).toHaveLength(count)
  expect(events).toEqual(Array.from({ length: count }, (_, i) => ({ n: i })))
})

it('a later saveExecution does not duplicate events recorded via recordAttemptEvent', async () => {
  await saveExecution(fixtureExecution(), fixtureGraph(), 'TaskStarted')
  await recordAttemptEvent('p', 'a', { type: 'text', text: 'only-once' })
  await saveExecution(fixtureExecution('review'), fixtureGraph(), 'VerificationCompleted')
  expect(loadExecution('p')!.attempts[0].events).toEqual([{ type: 'text', text: 'only-once' }])
})

it('getAttemptEvents returns only the requested attempt\'s events, in order', async () => {
  const execution = fixtureExecution()
  execution.attempts.push({ id: 'b', taskId: 't', specVersion: 1, startedAt: 1, status: 'failed', implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: [] })
  await saveExecution(execution, fixtureGraph(), 'TaskStarted')
  await recordAttemptEvent('p', 'a', { n: 1 })
  await recordAttemptEvent('p', 'b', { n: 'other-attempt' })
  await recordAttemptEvent('p', 'a', { n: 2 })
  expect(getAttemptEvents('p', 'a')).toEqual([{ n: 1 }, { n: 2 }])
})

it('archived attempts round-trip separately from active ones', async () => {
  const execution = fixtureExecution('accepted')
  execution.archivedAttempts = [{ id: 'old', taskId: 't', specVersion: 0, startedAt: -1, status: 'discarded', implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: [] }]
  await saveExecution(execution, fixtureGraph(), 'TaskStarted')
  const restored = loadExecution('p')!
  expect(restored.attempts.map(a => a.id)).toEqual(['a'])
  expect(restored.archivedAttempts?.map(a => a.id)).toEqual(['old'])
})

it.each(['running', 'review', 'awaiting_permission', 'awaiting_install'] as const)('hasOpenAttempts is true while an attempt is %s', async status => {
  await saveExecution(fixtureExecution(status), fixtureGraph(), 'TaskStarted')
  expect(hasOpenAttempts('p')).toBe(true)
})

it('hasOpenAttempts is false once every attempt is terminal, hasExecutionStarted stays true', async () => {
  await saveExecution(fixtureExecution('accepted'), fixtureGraph(), 'TaskAccepted')
  expect(hasOpenAttempts('p')).toBe(false)
  expect(hasExecutionStarted('p')).toBe(true)
})

it('hasExecutionStarted is false and hasOpenAttempts is false before anything was ever saved', () => {
  expect(hasExecutionStarted('never-started')).toBe(false)
  expect(hasOpenAttempts('never-started')).toBe(false)
})

it('loadExecution returns undefined for a project with no execution yet', () => {
  expect(loadExecution('p')).toBeUndefined()
})

it('REGRESSION (migration): a pre-existing events.jsonl project is reconstructed into the new tables on first access, without touching the old log', async () => {
  const graph = fixtureGraph()
  const legacy = fixtureExecution('review')
  await saveExecutionLegacy(legacy, graph, 'TaskStarted')
  const dbPath = join(state.dir, 'projects', 'p', 'execution.db')
  expect(existsSync(dbPath)).toBe(false)
  const migrated = loadExecution('p')!
  expect(migrated.attempts[0]).toMatchObject({ id: 'a', taskId: 't', status: 'review' })
  expect(existsSync(dbPath)).toBe(true)
  const eventsPath = join(state.dir, 'projects', 'p', 'events.jsonl')
  expect(existsSync(eventsPath)).toBe(true)
})

it('REGRESSION (Restart-Wiederherstellung fehlte): an attempt abandoned mid-run before a restart is marked interrupted on first access, not left stuck at running', async () => {
  await saveExecution(fixtureExecution('running'), fixtureGraph(), 'TaskStarted')
  // Simulate a real app restart - a fresh module instance with an empty
  // in-memory cache, same on-disk db.
  vi.resetModules()
  const fresh = await import('../execution-store')
  const summary = fresh.getExecutionSummary('p')!
  expect(summary.attempts[0].status).toBe('interrupted')
  expect(summary.phase).toBe('halted')
  expect(fresh.hasOpenAttempts('p')).toBe(false)
  fresh.closeAllForTesting()
})

it('REGRESSION (Restart-Wiederherstellung griff nicht bei der Migration): an attempt still "running" in the legacy event log comes back interrupted through loadExecution, not running - this is the exact bug reported live after restarting to pick up this rewrite', async () => {
  await saveExecutionLegacy(fixtureExecution('running'), fixtureGraph(), 'TaskStarted')
  const migrated = loadExecution('p')!
  expect(migrated.attempts[0].status).toBe('interrupted')
  expect(hasOpenAttempts('p')).toBe(false)
})

it('REGRESSION (Korruption): a corrupted execution.db is renamed aside instead of crashing, and a fresh one works', async () => {
  // Module-level connections are cached per project (openDbs), so corruption
  // written to the file on disk is only detected the next time the module
  // opens it fresh - i.e. after a real app restart. vi.resetModules() +
  // a dynamic re-import simulates exactly that instead of reusing the
  // already-open in-memory handle from a prior call in this same test file.
  await saveExecution(fixtureExecution(), fixtureGraph(), 'TaskStarted')
  closeAllForTesting() // release the Windows file lock before overwriting it below
  const dbPath = join(state.dir, 'projects', 'p', 'execution.db')
  writeFileSync(dbPath, 'not a sqlite file')
  vi.resetModules()
  const fresh = await import('../execution-store')
  const restored = fresh.loadExecution('p')
  expect(restored).toBeUndefined()
  const files = readdirSync(join(state.dir, 'projects', 'p'))
  expect(files.some(f => f.startsWith('execution.db.corrupted-'))).toBe(true)
  await fresh.saveExecution(fixtureExecution(), fixtureGraph(), 'TaskStarted')
  expect(fresh.loadExecution('p')?.attempts[0].id).toBe('a')
  fresh.closeAllForTesting()
})
