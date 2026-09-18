import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectEngine, type EngineeringPorts } from '../../services/project-engine'
import { isWithinScope, checkScope } from '@ai-council/project-domain'
import type { ChangeRequest, ProjectExecution, ProjectSpecification, TaskGraphSnapshot } from '@ai-council/project-domain'
import type { CodingExecutor } from '@ai-council/coding'
import { formatPermissionDenialWarning } from '@ai-council/coding'

let dir: string, graph: TaskGraphSnapshot, spec: ProjectSpecification, persisted: ProjectExecution | undefined
let reviewText: string, ports: EngineeringPorts, starts: number, changeRequests: ChangeRequest[]
let emptyReviews: number, streamReview: boolean
// Set by a test right before starting a task to simulate the implementer's
// first turn being denied one or more actions - consumed (cleared) the
// first time a non-read-only call observes it, so a resumed/retry call
// behaves normally afterward. resumeSession calls are recorded so tests can
// assert the elevated tier/sessionId actually reached the executor.
let denyOnce: string[] | undefined
let lastResumeCall: { sessionId: string; tier: string | undefined } | undefined
// Recorded by the default council port below - lets tests confirm a local-
// agent council run was actually grounded in a real directory rather than
// the empty app-owned scratch dir (see participant-factory.ts).
let lastCouncilCall: { chairId?: string; workingDirectory?: string } | undefined
// Captured on every read-only (review) call - lets tests confirm what the
// reviewer prompt actually said, e.g. whether an executor-specific
// instruction was included only for the executor it's meant for.
let lastReviewPrompt: string | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'council-engine-'))
  graph = { projectId: 'p', specVersion: 1, status: 'human_approved', workingDirectory: join(dir, 'app'),
    chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0,
    tasks: [{ id: 'T1', specVersion: 1, status: 'pending', title: 'App', description: 'Build', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } }] }
  spec = { id: 'p', version: 1, status: 'human_approved', goal: 'App', requirements: [], nonGoals: [], architectureNotes: '', risks: [], openQuestions: [], chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0 }
  persisted = undefined; starts = 0; changeRequests = []; denyOnce = undefined; lastResumeCall = undefined; lastCouncilCall = undefined
  lastReviewPrompt = undefined
  reviewText = '{"verdict":"pass","findings":[]}'
  emptyReviews = 0; streamReview = false
  const executor: CodingExecutor = {
    id: 'fake', detect: async () => ({ installed: true, authStatus: 'authenticated' }),
    capabilities: () => ({ resumeSession: true, fileEditing: true, shellAccess: true }),
    startTask: task => {
      starts++
      return { taskId: 'fake', events: (async function* () {
        if (denyOnce) {
          yield { type: 'warning' as const, message: formatPermissionDenialWarning('Aktion(en)', denyOnce.length, denyOnce) }
          if (task.permissionTier !== 'read-only') {
            denyOnce = undefined
            yield { type: 'done' as const, summary: 'implemented (partial - denied before completion)', sessionId: 'sess-1' }
            return
          }
        }
        if (task.permissionTier !== 'read-only') await writeFile(join(task.workingDirectory, 'app.txt'), 'working app')
        if (task.permissionTier === 'read-only') {
          lastReviewPrompt = task.prompt
          if (emptyReviews > 0) {
            emptyReviews--
            yield { type: 'done' as const, summary: '' }
            return
          }
          if (streamReview) {
            yield { type: 'text' as const, text: reviewText.slice(0, 10) }
            yield { type: 'text' as const, text: reviewText.slice(10) }
            yield { type: 'done' as const, summary: ' ' }
            return
          }
        }
        yield { type: 'done' as const, summary: task.permissionTier === 'read-only' ? reviewText : 'implemented', sessionId: 'sess-1' }
      })() }
    }, streamEvents: () => undefined, getStatus: () => undefined, abort: () => {},
    resumeSession: (sessionId, task) => {
      lastResumeCall = { sessionId, tier: task.permissionTier }
      return { taskId: 'fake-resumed', events: (async function* () {
        await writeFile(join(task.workingDirectory, 'app.txt'), 'working app')
        yield { type: 'done' as const, summary: 'implemented after elevation', sessionId }
      })() }
    }
  }
  ports = { worktreesRoot: join(dir, 'worktrees'), graph: () => graph, spec: () => spec,
    load: () => persisted && structuredClone(persisted), save: async (state, nextGraph) => {
      persisted = structuredClone(state); graph = structuredClone(nextGraph)
      for (const task of graph.tasks) {
        // Mirrors engineering-store.ts's saveExecution() fix: these two
        // statuses are only ever set by explicit TaskGraph calls (see
        // applyChangeRequest/start()'s needs_revalidation branch), never
        // inferred from the latest attempt.
        if (task.status === 'invalidated' || task.status === 'needs_revalidation') continue
        const attempt = [...state.attempts].reverse().find(a => a.taskId === task.id)
        if (attempt) task.status = attempt.status === 'accepted' ? 'accepted' : attempt.status === 'review' ? 'review'
          : (attempt.status === 'running' || attempt.status === 'awaiting_permission' || attempt.status === 'awaiting_install') ? 'in_progress' : 'failed'
      }
    },
    saveGraph: async (_id, nextGraph) => { graph = structuredClone(nextGraph) },
    changeRequest: (_id, crId) => changeRequests.find(cr => cr.id === crId),
    openChangeRequest: async (_id, cr) => {
      changeRequests.push({ ...cr, id: `cr-${changeRequests.length + 1}`, createdAt: Date.now(), status: 'pending' })
    },
    markChangeRequestApplied: async (_id, crId) => {
      const cr = changeRequests.find(c => c.id === crId)
      if (cr) cr.appliedAt = Date.now()
    },
    context: () => 'Build app.txt', executor: () => executor,
    council: async (_prompt, _signal, chairId, workingDirectory) => { lastCouncilCall = { chairId, workingDirectory }; return reviewText },
    emit: () => {} }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const roles = { implementerId: 'one', reviewerId: 'two', challengerId: 'three' }
async function configured(success = true) {
  const engine = new ProjectEngine(ports)
  await engine.configure('p', [{ executable: process.execPath, args: ['-e', success ? "if(require('fs').readFileSync('app.txt','utf8') !== 'working app')process.exit(1)" : 'process.exit(1)'], timeoutMs: 10000 }], 3)
  return engine
}
async function completed(engine: ProjectEngine) {
  await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.status).not.toBe('running'), { timeout: 45000, interval: 100 })
  // Finish the asynchronous persistence/cleanup turn before another command.
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('controlled project execution', { timeout: 60000 }, () => {
  it.each(['unchanged', 'file', 'context', 'requirements', 'checks', 'reviewer'] as const)(
    'resumes a partial review safely across restart: %s', async change => {
      const original = ports.executor('one')
      let interrupted = true
      const counts: Record<string, number> = {}
      ports.executor = id => ({ ...original, startTask: (task, options) => {
        counts[id] = (counts[id] ?? 0) + 1
        if (id !== 'three' || !interrupted) return original.startTask(task, options)
        return { taskId: 'quota', events: (async function* () {
          // Simulate one reviewer finishing before the other exhausts quota.
          await vi.waitFor(() => expect(persisted?.attempts[0].reviewCheckpoint?.results.two).toBeDefined(), { timeout: 15000 })
          yield { type: 'error' as const, message: 'Usage limit reached' }
        })() }
      } })
      const engine = await configured()
      await engine.start('p', 'T1', roles); await completed(engine)
      const before = (await engine.get('p')).attempts[0]
      expect(before.status).toBe('paused')
      expect(before.reviewCheckpoint?.results.two.verdict).toBe('pass')
      interrupted = false
      if (change === 'file') await writeFile(join(before.worktree!.path, 'additional.txt'), 'new relevant file')
      if (change === 'context') ports.context = () => 'Build app.txt with updated dependency contract'
      if (change === 'requirements') spec.architectureNotes = 'New binding constraint'
      if (change === 'checks') persisted!.commands[0].args[1] += ';console.log("additional evidence")'
      const restarted = new ProjectEngine(ports)
      await restarted.start('p', 'T1', { ...roles, reviewerId: change === 'reviewer' ? 'new-reviewer' : 'two' }); await completed(restarted)
      const after = (await restarted.get('p')).attempts[0]
      expect(after.status).toBe('review')
      expect(after.reviews).toHaveLength(2)
      expect(after.id).toBe(before.id)
      expect(counts.one).toBe(1)
      expect(counts.three).toBe(2)
      expect(counts.two).toBe(change === 'unchanged' || change === 'reviewer' ? 1 : 2)
      if (change === 'reviewer') expect(counts['new-reviewer']).toBe(1)
      expect(after.reviewCheckpoint).toBeUndefined()
    })

  it('raises only the paused task time budget after restart and resumes its existing workspace', async () => {
    const engine = await configured()
    await engine.start('p', 'T1', { implementerId: 'one', reviewerId: 'two' }); await completed(engine)
    const before = (await engine.get('p')).attempts[0]
    persisted!.attempts[0].status = 'paused'
    persisted!.attempts[0].runtime = { ...before.runtime!, activeMs: 1800337, checkpoint: 'review', failureKind: 'budget', retryable: true }
    persisted!.attempts[0].error = 'Laufzeitbudget erreicht. Budget anpassen und fortsetzen.'
    persisted!.attempts[0].reviewPending = true
    persisted!.maxAttempts = 10
    const restarted = new ProjectEngine(ports)
    const newBudget = { maxCalls: 8, maxCorrections: 2, maxActiveMs: 3600000 }
    await restarted.setTaskBudget('p', 'T1', newBudget)
    expect((await restarted.get('p')).attempts[0].runtime!.activeMs).toBe(1800337)
    expect((await restarted.get('p')).budget).toBeUndefined()
    await restarted.start('p', 'T1', { implementerId: 'one', reviewerId: 'two' }); await completed(restarted)
    const after = await restarted.get('p')
    expect(after.attempts).toHaveLength(1)
    expect(after.attempts[0]).toMatchObject({ id: before.id, worktree: before.worktree, status: 'review' })
    expect(after.taskBudgets?.T1).toEqual(newBudget)
  })

  it('changing a task budget preserves approvals and rolls back after a save failure', async () => {
    await configured()
    persisted!.attempts.push({ id: 'approved', taskId: 'T1', specVersion: 1, startedAt: 0, status: 'review', implementerId: 'one', reviewerId: 'two', commit: 'commit', verification: [], reviews: [], events: [] })
    persisted!.phase = 'release_approval'; persisted!.releaseCommit = 'release'
    const engine = new ProjectEngine(ports)
    const budget = { maxCalls: 8, maxCorrections: 2, maxActiveMs: 3600000 }
    await engine.setTaskBudget('p', 'T1', budget)
    expect((await engine.get('p'))).toMatchObject({ phase: 'release_approval', releaseCommit: 'release', attempts: [{ status: 'review', commit: 'commit' }] })
    await expect(engine.setTaskBudget('p', 'missing', budget)).rejects.toThrow('Task nicht gefunden')
    await expect(engine.setTaskBudget('p', 'T1', { ...budget, maxActiveMs: NaN })).rejects.toThrow()
    ports.save = async () => { throw new Error('disk failure') }
    await expect(engine.setTaskBudget('p', 'T1', { ...budget, maxCalls: 20 })).rejects.toThrow('disk failure')
    expect((await engine.get('p')).taskBudgets?.T1).toEqual(budget)
  })
  it('pauses authentication failures and resumes the same workspace without spending another attempt', async () => {
    const original = ports.executor('one')
    ports.executor = () => ({ ...original, startTask: () => ({ taskId: 'auth', events: (async function* () {
      yield { type: 'error' as const, message: 'Not logged in · Please run /login' }
    })() }) })
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    const before = (await engine.get('p')).attempts[0]
    expect(before).toMatchObject({ status: 'paused', runtime: { failureKind: 'authentication', retryable: true } })
    expect(before.runtime!.calls).toHaveLength(1)
    persisted!.maxAttempts = 1
    ports.executor = () => original
    const restarted = new ProjectEngine(ports)
    await restarted.start('p', 'T1', { implementerId: 'one', reviewerId: 'two' }); await completed(restarted)
    const after = await restarted.get('p')
    expect(after.attempts).toHaveLength(1)
    expect(after.attempts[0]).toMatchObject({ id: before.id, worktree: before.worktree, status: 'review' })
    expect(after.attempts[0].runtime!.calls).toHaveLength(3)
  })

  it('enforces a shared call budget for simultaneous reviews and permits an explicit increase', async () => {
    const engine = await configured()
    await engine.configure('p', persisted!.commands, 3, { maxCalls: 2, maxCorrections: 2, maxActiveMs: 600000 })
    await engine.start('p', 'T1', roles); await completed(engine)
    const before = (await engine.get('p')).attempts[0]
    expect(before.status).toBe('paused')
    expect(before.runtime?.failureKind).toBe('budget')
    expect(before.runtime!.calls.length).toBeLessThanOrEqual(2)
    await engine.configure('p', persisted!.commands, 3, { maxCalls: 6, maxCorrections: 2, maxActiveMs: 600000 })
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('review')
  })

  it('stops a running agent when the active time budget is reached', async () => {
    const original = ports.executor('one')
    ports.executor = () => ({ ...original, startTask: (_task, options) => ({ taskId: 'slow', events: (async function* () {
      if (!options?.signal?.aborted) await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
    })() }) })
    const engine = await configured()
    await engine.configure('p', persisted!.commands, 3, { maxCalls: 8, maxCorrections: 2, maxActiveMs: 1000 })
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0]).toMatchObject({ status: 'paused', runtime: { failureKind: 'budget' } })
  })
  it('fixes failed automatic checks before spending calls on reviewers', async () => {
    const engine = await configured(false)
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('failed')
    expect(lastReviewPrompt).toBeUndefined()
    expect(starts).toBe(2)
  })
  it('continues a failed correction after restart with its files and findings instead of starting over', async () => {
    reviewText = JSON.stringify({ verdict: 'fail', resolution: 'implementation', findings: [{ severity: 'medium', file: 'app.txt', message: 'Include decimal arithmetic overflow.' }] })
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    const before = (await engine.get('p')).attempts[0]
    expect(before.status).toBe('failed')
    expect(before.error).toContain('Include decimal arithmetic overflow.')
    await writeFile(join(before.worktree!.path, 'preserved.txt'), 'existing progress')
    persisted!.maxAttempts = 1
    reviewText = '{"verdict":"pass","findings":[]}'
    const original = ports.executor('one')
    const fixPrompts: string[] = []
    ports.executor = () => ({ ...original, startTask: task => {
      if (task.permissionTier !== 'read-only') fixPrompts.push(task.prompt)
      return original.startTask(task)
    } })
    const restarted = new ProjectEngine(ports)
    await restarted.setTaskBudget('p', 'T1', { maxCalls: 12, maxCorrections: 3, maxActiveMs: 1800000 })
    await restarted.start('p', 'T1', roles); await completed(restarted)
    const after = await restarted.get('p')
    expect(after.attempts).toHaveLength(1)
    expect(after.attempts[0]).toMatchObject({ id: before.id, worktree: before.worktree, status: 'review' })
    expect(await readFile(join(before.worktree!.path, 'preserved.txt'), 'utf8')).toBe('existing progress')
    expect(fixPrompts).toHaveLength(1)
    expect(fixPrompts[0]).toContain('Include decimal arithmetic overflow.')
  })

  it('never reuses a policy-violating workspace as a normal correction retry', async () => {
    await configured()
    persisted!.maxAttempts = 1
    persisted!.attempts = [{ id: 'unsafe', taskId: 'T1', specVersion: 1, startedAt: 0, status: 'failed',
      implementerId: 'one', reviewerId: 'two', verification: [], events: [],
      reviews: [{ verdict: 'fail', findings: [] }], worktree: { path: 'unsafe', branch: 'unsafe', sourceRepo: 'unsafe' },
      taskStartCommit: 'old', error: 'POLICY VIOLATION: source changed' }]
    await expect(new ProjectEngine(ports).start('p', 'T1', roles)).rejects.toThrow('Versuchslimit')
    await expect(new ProjectEngine(ports).start('p', 'T1', { ...roles, recheckWorkspace: true })).rejects.toThrow('Arbeitsstand')
  })

  it.each([false, true])('rechecks a reviewer-modified workspace with fresh checks and scope enforcement (outside scope: %s)', async outsideScope => {
    const engine = await configured()
    await engine.start('p', 'T1', { ...roles, challengerId: undefined }); await completed(engine)
    const attempt = persisted!.attempts[0]
    await writeFile(join(attempt.worktree!.path, 'reviewer-test.txt'), 'preserved review change')
    attempt.status = 'failed'
    attempt.reviewPending = false
    attempt.error = 'POLICY VIOLATION: Das Arbeitsverzeichnis hat sich während eines schreibgeschützten Laufs verändert: reviewer-test.txt'
    persisted!.maxAttempts = 1
    if (outsideScope) graph.tasks[0].scope.allowedPaths = ['app.txt']
    const original = ports.executor('one')
    const tiers: unknown[] = []
    ports.executor = () => ({ ...original, startTask: task => { tiers.push(task.permissionTier); return original.startTask(task) } })
    const restarted = new ProjectEngine(ports)
    await restarted.start('p', 'T1', { ...roles, challengerId: undefined, recheckWorkspace: true }); await completed(restarted)
    const after = (await restarted.get('p')).attempts
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(attempt.id)
    expect(after[0].worktree).toEqual(attempt.worktree)
    expect(after[0].verification.length).toBeGreaterThan(0)
    expect(after[0].status).toBe(outsideScope ? 'failed' : 'review')
    expect(tiers).toEqual(outsideScope ? [] : ['read-only'])
    if (outsideScope) expect(after[0].error).toContain('Scopes')
    expect(await readFile(join(attempt.worktree!.path, 'reviewer-test.txt'), 'utf8')).toBe('preserved review change')
  })

  it('repairs a locally resolvable escalation in the same attempt without a change request', async () => {
    const original = ports.executor('one')
    let writes = 0
    ports.executor = () => ({ ...original, startTask: task => {
      if (task.permissionTier !== 'read-only') {
        writes++
        reviewText = writes === 1
          ? JSON.stringify({ verdict: 'escalate', resolution: 'implementation', findings: [{ severity: 'high', message: 'Defensive Kopie und Überlaufprüfung ergänzen.' }] })
          : '{"verdict":"pass","findings":[]}'
      }
      return original.startTask(task)
    } })
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    const state = await engine.get('p')
    expect(state.attempts).toHaveLength(1)
    expect(state.attempts[0].status).toBe('review')
    expect(writes).toBe(2)
    expect(changeRequests).toEqual([])
  })

  it('keeps main unchanged until verified integration, final council and explicit release, across restart', async () => {
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('review')
    await expect(readFile(join(graph.workingDirectory!, 'app.txt'))).rejects.toThrow()
    const restarted = new ProjectEngine(ports)
    await restarted.accept('p', 'T1')
    await expect(readFile(join(graph.workingDirectory!, 'app.txt'))).rejects.toThrow()
    await expect(restarted.release('p', 'not-approved')).rejects.toThrow(/Release blockiert/)
    await restarted.finalReview('p')
    const state = await restarted.get('p')
    // REGRESSION (finales Council lief im leeren Scratch-Verzeichnis): the
    // final council must be grounded in the real integration worktree, not
    // an app-owned scratch dir with no relation to the actual integrated code.
    expect(lastCouncilCall?.workingDirectory).toBe(state.integration?.path)
    expect(state.integration?.path).toBeTruthy()
    await expect(restarted.release('p', 'wrong-commit')).rejects.toThrow(/Freigabe/)
    await restarted.release('p', state.releaseCommit!)
    expect(await readFile(join(graph.workingDirectory!, 'app.txt'), 'utf-8')).toBe('working app')
    expect((await restarted.get('p')).phase).toBe('done')
  })
  it('REGRESSION (release blieb nach ChangeRequest blockiert): an invalidated (correctly-superseded) task does not block finalReview()/release()', async () => {
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    await engine.accept('p', 'T1')
    // Simulates what applyChangeRequest() leaves behind: an old task marked
    // 'invalidated' with a replacement, never itself becoming 'accepted'.
    graph.tasks.push({ ...graph.tasks[0], id: 'OLD', status: 'invalidated', replacedByTaskId: ['T1'] })
    await engine.finalReview('p')
    const state = await engine.get('p')
    expect(state.finalVerdict?.verdict).toBe('pass')
    await engine.release('p', state.releaseCommit!)
    expect((await engine.get('p')).phase).toBe('done')
  })
  it('REGRESSION (Scope-Prüfung umgangen durch committete Änderungen): a committed out-of-scope change is caught, not just an uncommitted one', async () => {
    graph.tasks[0].scope = { allowedPaths: ['app.txt'] }
    const commitsOutsideScope: CodingExecutor = {
      id: 'fake', detect: async () => ({ installed: true, authStatus: 'authenticated' }),
      capabilities: () => ({ resumeSession: true, fileEditing: true, shellAccess: true }),
      startTask: task => ({
        taskId: 'fake',
        events: (async function* () {
          // A 'full'-tier agent has shell access and isn't supposed to
          // commit (mergeWorktree does that later) - but nothing stops one
          // that does. Before the fix, git status/diff HEAD reported this
          // worktree as clean right after the commit, so the scope check
          // never saw it.
          await writeFile(join(task.workingDirectory, 'secret.txt'), 'sneaky out-of-scope change')
          execFileSync('git', ['add', '-A'], { cwd: task.workingDirectory })
          execFileSync('git', ['commit', '-m', 'sneaky'], { cwd: task.workingDirectory })
          yield { type: 'done' as const, summary: 'implemented', sessionId: 'sess-1' }
        })()
      }),
      streamEvents: () => undefined, getStatus: () => undefined, abort: () => {}
    }
    ports.executor = () => commitsOutsideScope
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('failed')
    expect(attempt.error).toMatch(/POLICY VIOLATION/)
  })
  it('blocks a real failing command even when every agent claims success', async () => {
    const engine = await configured(false)
    await engine.start('p', 'T1', roles)
    await completed(engine)
    expect((await engine.get('p')).attempts[0].verification[0].exitCode).toBe(1)
    await expect(engine.accept('p', 'T1')).rejects.toThrow(/Annahme blockiert/)
  })
  it('rejects malformed review verdicts instead of interpreting prose as success', async () => {
    reviewText = 'Everything is fine'
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('failed')
  })
  it('uses streamed review text when the completion summary is empty', async () => {
    streamReview = true
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('review')
    expect(starts).toBe(3)
  })
  it('resumes a failed review after restart without reimplementing or consuming an attempt', async () => {
    reviewText = 'invalid review'
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    const before = (await engine.get('p')).attempts[0]
    expect(before.reviewPending).toBe(true)
    // Reviewer and challenger now run concurrently (see runReview()/
    // Promise.all in execute()) - both start and both throw on the same
    // invalid text, instead of the old sequential loop's first-iteration
    // throw pre-empting the second reviewer entirely.
    expect(starts).toBe(3)
    reviewText = '{"verdict":"pass","findings":[]}'
    const restarted = new ProjectEngine(ports)
    const originalExecutor = ports.executor
    const selectedExecutors: string[] = []
    ports.executor = id => { selectedExecutors.push(id); return originalExecutor(id) }
    await restarted.start('p', 'T1', { implementerId: 'new-implementer', reviewerId: 'new-reviewer' }); await completed(restarted)
    const after = await restarted.get('p')
    expect(after.attempts).toHaveLength(1)
    expect(after.attempts[0]).toMatchObject({ id: before.id, worktree: before.worktree, status: 'review', reviewPending: false })
    expect(after.attempts[0]).toMatchObject({ implementerId: 'new-implementer', reviewerId: 'new-reviewer' })
    expect(after.attempts[0].challengerId).toBeUndefined()
    expect(selectedExecutors).toEqual(['new-implementer', 'new-reviewer', 'new-reviewer'])
    expect(starts).toBe(4)
  })
  it('opens an escalation when a reviewer returns escalate, even though the challenger runs concurrently', async () => {
    reviewText = '{"verdict":"escalate","findings":[],"reason":"architecture change"}'
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('escalated')
    // Both reviewer and challenger run concurrently (see the perf note on
    // runReview()'s Promise.all call site) - an escalating reviewer no
    // longer skips the challenger's call the way the old sequential loop did.
    expect(starts).toBe(3)
    expect(changeRequests).toHaveLength(1)
    expect(changeRequests[0].reason).toContain('architecture change')
  })
  it('REGRESSION (Reviewer/Challenger liefen nacheinander statt gleichzeitig): a slow reviewer does not block the challenger from finishing first', async () => {
    const order: string[] = []
    const baseExecutor = ports.executor('one')
    ports.executor = (execId) => ({ ...baseExecutor, startTask: (task, options) => {
      const handle = baseExecutor.startTask(task, options)
      return { ...handle, events: (async function* () {
        if (task.permissionTier === 'read-only') {
          order.push(`start:${execId}`)
          // Only 'two' (the reviewer) is artificially slowed down; 'three'
          // (the challenger) is not. Which one's *start* is pushed first is
          // not deterministic (both race real fingerprintWorkspace() git
          // calls on the same worktree beforehand) - the actual proof of
          // concurrency is that the un-delayed 'three' still finishes
          // before the artificially delayed 'two', which is only possible
          // if both ran overlapping instead of one after another.
          if (execId === 'two') await new Promise(resolve => setTimeout(resolve, 300))
        }
        yield* handle.events
        if (task.permissionTier === 'read-only') order.push(`done:${execId}`)
      })() }
    } })
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    expect((await engine.get('p')).attempts[0].status).toBe('review')
    expect(order).toContain('start:two')
    expect(order).toContain('start:three')
    expect(order.indexOf('done:three')).toBeLessThan(order.indexOf('done:two'))
  })
  it(
    'REGRESSION (Sicherheitsreview: sich selbst zurücknehmender Schreibvorgang blieb unsichtbar): ' +
      'a challenger write that self-reverts within the retry window still proceeds, but is recorded as a warning instead of vanishing silently',
    async () => {
      const baseExecutor = ports.executor('one')
      ports.executor = (execId) => ({ ...baseExecutor, startTask: (task, options) => {
        const handle = baseExecutor.startTask(task, options)
        return { ...handle, events: (async function* () {
          if (execId === 'three' && task.permissionTier === 'read-only') {
            // Simulates the exact gap the security review flagged: a
            // read-only turn slips past its permission tier and writes,
            // but the write is gone again before verifyWorkspaceUnchanged()'s
            // retry fires - must not be allowed to pass through silently.
            // verifyWorkspaceUnchanged()'s first check (a real snapshotWorkspace()
            // call, spawning real git subprocesses) alone can take a few
            // hundred ms on Windows, and its retry sleep is a fixed 500ms -
            // this delay must land comfortably after the first check has
            // actually sampled the filesystem but comfortably before the
            // retry's own check, hence the generous, well-separated delay.
            const marker = join(task.workingDirectory, 'unexpected.txt')
            await writeFile(marker, 'a write that should not happen during a read-only turn')
            setTimeout(() => { void rm(marker, { force: true }) }, 650)
          }
          yield* handle.events
        })() }
      } })
      const engine = await configured()
      await engine.start('p', 'T1', roles); await completed(engine)
      const attempt = (await engine.get('p')).attempts[0]
      expect(attempt.status).toBe('review')
      const warning = attempt.events.find(e =>
        (e as { kind: string; event: { type: string; message?: string } }).kind === 'executor_event' &&
        (e as { event: { type: string } }).event.type === 'warning' &&
        (e as { event: { message?: string } }).event.message?.includes('Vorübergehende Arbeitsverzeichnis-Abweichung')
      )
      expect(warning).toBeDefined()
    }
  )
  it('keeps the integration base intact on failed checks and permits retry', async () => {
    const marker = join(dir, 'fail-integration')
    const engine = new ProjectEngine(ports)
    await engine.configure('p', [{ executable: process.execPath, args: ['-e', "if(require('fs').existsSync(process.argv[1]))process.exit(1)", marker], timeoutMs: 10000 }], 3)
    await engine.start('p', 'T1', roles); await completed(engine)
    const before = await engine.get('p')
    await writeFile(marker, 'fail')
    await expect(engine.accept('p', 'T1')).rejects.toThrow(/Integrationsprüfung fehlgeschlagen/)
    const failed = await engine.get('p')
    expect(failed.integration).toEqual(before.integration)
    expect(failed.attempts[0].commit).toBeUndefined()
    await expect(readFile(join(before.integration!.path, 'app.txt'))).rejects.toThrow()
    await rm(marker)
    await engine.accept('p', 'T1')
    expect((await engine.get('p')).attempts[0].status).toBe('accepted')
  })
  it('can abort integration checks and discard the unaccepted task', async () => {
    const marker = join(dir, 'hang-integration')
    const started = join(dir, 'check-started')
    const engine = new ProjectEngine(ports)
    await engine.configure('p', [{ executable: process.execPath, args: ['-e', "const fs=require('fs');if(fs.existsSync(process.argv[1])){fs.writeFileSync(process.argv[2],'started');setTimeout(()=>{},30000)}", marker, started], timeoutMs: 40000 }], 3)
    await engine.start('p', 'T1', roles); await completed(engine)
    await writeFile(marker, 'hang')
    const acceptance = engine.accept('p', 'T1')
    const rejected = expect(acceptance).rejects.toThrow('Abgebrochen.')
    await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('started'), { timeout: 15000 })
    engine.abort('p')
    await rejected
    await engine.discard('p', 'T1')
    expect((await engine.get('p')).attempts[0].status).toBe('discarded')
  })
  it('retries an empty review without repeating implementation', async () => {
    emptyReviews = 1
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('review')
    expect(attempt.reviews).toHaveLength(2)
    expect(starts).toBe(4)
  })
  it('stops with a useful error after two empty reviews', async () => {
    emptyReviews = 10
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('failed')
    expect(attempt.error).toContain('Reviewer two hat auch beim zweiten Versuch keine Antwort')
    expect(attempt.reviews).toEqual([])
    // Reviewer and challenger both run concurrently and both exhaust their
    // own empty-response retry (2 calls each) instead of the challenger
    // never starting because the reviewer already threw first.
    expect(starts).toBe(5)
  })
  it('REGRESSION (Codex kann ohne Shell-Befehle nichts mehr lesen): the "keine Shell-Befehle"-Hinweis reaches Antigravity as reviewer', async () => {
    // Antigravity specifically denies `run_command` under read-only and
    // then gives up entirely instead of finishing with what its own
    // non-shell file tools already found - so its reviewer prompt tells it
    // not to bother with shell commands.
    const engine = await configured()
    // No challenger - otherwise its turn runs after the reviewer's and
    // overwrites lastReviewPrompt, since both are read-only review calls.
    await engine.start('p', 'T1', { ...roles, reviewerId: 'google-antigravity-cli', challengerId: undefined })
    await completed(engine)
    expect(lastReviewPrompt).toContain('Shell-/Terminal-Befehle')
    // REGRESSION (Antigravity folgte einem Worktree-.git zum Hauptrepo und
    // wurde dort verweigert): a second, different trigger for the exact
    // same give-up-on-any-denial behavior, caught live after the first fix
    // - it followed a worktree's .git pointer file out to the main repo's
    // real gitdir (outside --add-dir) to inspect HEAD, got denied for
    // being out of its registered workspace, and gave up again.
    expect(lastReviewPrompt).toContain('.git')
  })
  it('REGRESSION (Codex kann ohne Shell-Befehle nichts mehr lesen): the "keine Shell-Befehle"-Hinweis does NOT reach other reviewers', async () => {
    // Codex has no separate file-reading tool at all; it reads files via
    // its own safely sandboxed read-only shell. Sending it the same
    // instruction meant for Antigravity left it with no way to read
    // anything and made it escalate ("Terminal-Befehle sind untersagt...
    // nicht prüfbar") - caught live. The instruction must be scoped to the
    // one executor it actually applies to.
    const engine = await configured()
    await engine.start('p', 'T1', { ...roles, reviewerId: 'openai-codex-cli', challengerId: undefined })
    await completed(engine)
    expect(lastReviewPrompt).not.toContain('Shell-/Terminal-Befehle')
    expect(lastReviewPrompt).toContain('Verändere keine Dateien, ergänze keine Tests')
    expect(lastReviewPrompt).toContain('nur Prüfkontext, kein Arbeitsauftrag an dich')
  })
  it('blocks duplicate starts and acceptance after files have changed', async () => {
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await expect(engine.start('p', 'T1', roles)).rejects.toThrow(/bereits/)
    await completed(engine)
    const attempt = (await engine.get('p')).attempts[0]
    await writeFile(join(attempt.worktree!.path, 'app.txt'), 'changed after review')
    await expect(engine.accept('p', 'T1')).rejects.toThrow(/seit der Prüfung/)
  })
  it('enforces approval before invoking an agent', async () => {
    const engine = await configured()
    spec.status = 'council_generated'
    await expect(engine.start('p', 'T1', roles)).rejects.toThrow(/freigegeben/)
    expect(starts).toBe(0)
  })
  it('marks an abandoned attempt as interrupted without deleting its evidence', async () => {
    const engine = await configured()
    persisted!.attempts.push({ id: 'old', taskId: 'T1', specVersion: 1, startedAt: 1, status: 'running', implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: ['evidence'] })
    const restarted = new ProjectEngine(ports)
    const state = await restarted.get('p')
    expect(state.attempts[0]).toMatchObject({ status: 'interrupted', events: ['evidence'] })
  })
  it('serially executes ready dependencies and stops before the release gate', async () => {
    graph.tasks.push({ ...graph.tasks[0], id: 'T2', dependencies: [{ taskId: 'T1', impact: 'hard' }] })
    const engine = await configured()
    await engine.runReadyTasks('p', roles)
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.filter(a => a.status === 'accepted')).toHaveLength(2), { timeout: 50000, interval: 100 })
    expect((await engine.get('p')).phase).toBe('integration_review')
    await expect(readFile(join(graph.workingDirectory!, 'app.txt'))).rejects.toThrow()
  })
  it('checks path scopes without allowing traversal or unrelated files', () => {
    expect(isWithinScope('src/nested/app.ts', ['src/**/*.ts'])).toBe(true)
    expect(isWithinScope('src/app.ts', ['src/**/*.ts'])).toBe(true)
    expect(isWithinScope('secrets.env', ['src/**'])).toBe(false)
    expect(isWithinScope('../escape', ['**'])).toBe(false)
  })
  it('checkScope() denies with the offending paths listed, allows when everything is in scope', () => {
    expect(checkScope(['src/app.ts', 'secrets.env'], ['src/**'])).toEqual({ outcome: 'deny', reason: 'Änderungen außerhalb des freigegebenen Scopes: secrets.env' })
    expect(checkScope(['src/app.ts', 'src/nested/x.ts'], ['src/**'])).toEqual({ outcome: 'allow' })
    expect(checkScope([], ['src/**'])).toEqual({ outcome: 'allow' })
  })
})

describe('ChangeRequest lifecycle (targeted revalidation)', { timeout: 30000 }, () => {
  it('aborts replacement generation without changing the graph', async () => {
    graph = diamondGraph()
    const before = structuredClone(graph)
    ports.spec = (_id, version) => ({ ...spec, version })
    changeRequests = [approvedChangeRequest()]
    let entered = false
    ports.council = async (_prompt, signal) => {
      entered = true
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Abgebrochen.')), { once: true }))
    }
    const engine = new ProjectEngine(ports)
    const action = engine.applyChangeRequest('p', 'cr-1')
    const rejected = expect(action).rejects.toThrow('Abgebrochen.')
    await vi.waitFor(() => expect(entered).toBe(true))
    engine.abort('p')
    await rejected
    expect(graph).toEqual(before)
    expect(changeRequests[0].appliedAt).toBeUndefined()
  })
  function diamondGraph(): TaskGraphSnapshot {
    return {
      projectId: 'p', specVersion: 1, status: 'human_approved', workingDirectory: join(dir, 'app'),
      chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0,
      tasks: [
        { id: 'ROOT', specVersion: 1, status: 'accepted', title: 'Root', description: 'Root task', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } },
        { id: 'HARD', specVersion: 1, status: 'accepted', title: 'Hard dependent', description: '', requirementIds: [], dependencies: [{ taskId: 'ROOT', impact: 'hard' }], scope: { allowedPaths: [] } },
        { id: 'SOFT', specVersion: 1, status: 'accepted', title: 'Soft dependent', description: '', requirementIds: [], dependencies: [{ taskId: 'ROOT', impact: 'soft' }], scope: { allowedPaths: [] } },
        { id: 'SIBLING', specVersion: 1, status: 'pending', title: 'Unrelated', description: '', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } }
      ]
    }
  }
  function approvedChangeRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
    return { id: 'cr-1', projectId: 'p', reason: 'Architektur-Problem in ROOT', affectedRequirementIds: [], affectedTaskIds: ['ROOT'],
      proposedChanges: 'Anderer Ansatz für ROOT', severity: 'architecture', status: 'human_approved', createdAt: 0, resultingSpecVersion: 2, ...overrides }
  }

  it('invalidates hard dependents with a fresh replacement, marks soft dependents for revalidation under the same id, and re-stamps unaffected pending siblings to the new spec version', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    ports.council = async () =>
      '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"neu","dependencies":[],"scope":{"allowedPaths":[]}},' +
      '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"neu","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    const engine = new ProjectEngine(ports)
    await engine.applyChangeRequest('p', 'cr-1')

    expect(graph.specVersion).toBe(2)
    const root = graph.tasks.find(t => t.id === 'ROOT')!
    expect(root.status).toBe('invalidated')
    expect(root.replacedByTaskId).toEqual(['ROOT-2'])
    const hard = graph.tasks.find(t => t.id === 'HARD')!
    expect(hard.status).toBe('invalidated')
    expect(hard.replacedByTaskId).toEqual(['HARD-2'])
    const soft = graph.tasks.find(t => t.id === 'SOFT')!
    expect(soft.status).toBe('needs_revalidation')
    // Soft-invalidated tasks keep their OWN id, but a dependency edge that
    // pointed at a now-dead (invalidated) task is still rewired onto its
    // replacement - otherwise the edge would point at an id that can never
    // become 'accepted' again.
    expect(soft.dependencies).toEqual([{ taskId: 'ROOT-2', impact: 'soft' }])
    const sibling = graph.tasks.find(t => t.id === 'SIBLING')!
    expect(sibling.status).toBe('pending')
    expect(sibling.specVersion).toBe(2)
    const rootReplacement = graph.tasks.find(t => t.id === 'ROOT-2')!
    expect(rootReplacement.status).toBe('pending')
    expect(rootReplacement.specVersion).toBe(2)
    expect(changeRequests[0].appliedAt).toBeDefined()
  })

  it('REGRESSION (engineering-store.ts projection bug): an unrelated later save never reverts an invalidated/needs_revalidation task back to its old attempt-derived status', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    ports.council = async () =>
      '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
      '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    const engine = new ProjectEngine(ports)
    await engine.applyChangeRequest('p', 'cr-1')
    expect(graph.tasks.find(t => t.id === 'ROOT')!.status).toBe('invalidated')
    expect(graph.tasks.find(t => t.id === 'SOFT')!.status).toBe('needs_revalidation')

    // An unrelated action that also goes through the shared save() path -
    // before the fix, this silently reset ROOT/SOFT back to whatever their
    // stale HARD/ROOT attempts implied.
    await engine.configure('p', [{ executable: process.execPath, args: ['-e', "if(require('fs').readFileSync('app.txt','utf8') !== 'working app')process.exit(1)"], timeoutMs: 10000 }], 5)

    expect(graph.tasks.find(t => t.id === 'ROOT')!.status).toBe('invalidated')
    expect(graph.tasks.find(t => t.id === 'SOFT')!.status).toBe('needs_revalidation')
  })

  it('rejects applying the same ChangeRequest twice', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    ports.council = async () =>
      '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
      '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    const engine = new ProjectEngine(ports)
    await engine.applyChangeRequest('p', 'cr-1')
    await expect(engine.applyChangeRequest('p', 'cr-1')).rejects.toThrow(/bereits angewendet/)
  })

  it('rejects applying a ChangeRequest whose linked spec version is not yet approved', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'council_generated' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    const engine = new ProjectEngine(ports)
    await expect(engine.applyChangeRequest('p', 'cr-1')).rejects.toThrow(/noch nicht genehmigt/)
  })

  it('REGRESSION (incomplete Council replacement): fails loudly instead of silently leaving an invalidated task with no replacement', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    // Only replaces ROOT, silently omits HARD (which invalidateDownstream also invalidates).
    ports.council = async () => '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    const engine = new ProjectEngine(ports)
    await expect(engine.applyChangeRequest('p', 'cr-1')).rejects.toThrow(/unvollständig/)
  })

  it('REGRESSION (Ersatz-Task-Council lief im leeren Scratch-Verzeichnis): the replacement-task council call is grounded in the real project directory', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    let capturedWorkingDirectory: string | undefined
    ports.council = async (_prompt, _signal, _chairId, workingDirectory) => {
      capturedWorkingDirectory = workingDirectory
      return '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
        '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    }
    const engine = new ProjectEngine(ports)
    await engine.applyChangeRequest('p', 'cr-1')
    expect(capturedWorkingDirectory).toBe(graph.workingDirectory)
  })

  it('REGRESSION (mehrere Ersatz-Tasks verloren Dependency-Verdrahtung): splitting one invalidated task into two replacements keeps dependents wired to both', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    // The Council splits ROOT into two replacement tasks (the prompt
    // explicitly allows this - see buildReplacementTaskPrompt).
    ports.council = async () =>
      '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2A","requirementIds":[],"title":"Root v2a","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
      '{"replacesTaskId":"ROOT","id":"ROOT-2B","requirementIds":[],"title":"Root v2b","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
      '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    const engine = new ProjectEngine(ports)
    await engine.applyChangeRequest('p', 'cr-1')

    const root = graph.tasks.find(t => t.id === 'ROOT')!
    expect(root.replacedByTaskId).toEqual(['ROOT-2A', 'ROOT-2B'])
    const soft = graph.tasks.find(t => t.id === 'SOFT')!
    // Before the fix, only the last replacement (ROOT-2B) survived here -
    // a dependent would become ready without waiting for ROOT-2A too.
    expect(soft.dependencies).toEqual([
      { taskId: 'ROOT-2A', impact: 'soft' },
      { taskId: 'ROOT-2B', impact: 'soft' }
    ])
  })

  it('REGRESSION (ChangeRequest-Anwendung nicht crashsicher): a retry after the graph was already migrated finishes cleanly instead of duplicating replacement tasks', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    let councilCalls = 0
    ports.council = async () => {
      councilCalls++
      return '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
        '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    }
    // Simulates a crash after the graph was saved at the new spec version
    // but before markChangeRequestApplied ran: appliedAt is still unset, so
    // a naive retry would fail at the guard below and hit this point again.
    const originalMarkApplied = ports.markChangeRequestApplied
    let crashOnce = true
    ports.markChangeRequestApplied = async (projectId, crId) => {
      if (crashOnce) { crashOnce = false; throw new Error('simulated crash') }
      await originalMarkApplied(projectId, crId)
    }
    const engine = new ProjectEngine(ports)
    await expect(engine.applyChangeRequest('p', 'cr-1')).rejects.toThrow(/simulated crash/)
    expect(graph.specVersion).toBe(2)
    expect(changeRequests[0].appliedAt).toBeUndefined()

    await engine.applyChangeRequest('p', 'cr-1')
    expect(changeRequests[0].appliedAt).toBeDefined()
    expect(councilCalls).toBe(1) // not re-run on retry - would otherwise duplicate ROOT-2/HARD-2
    expect(graph.tasks.filter(t => t.id === 'ROOT-2')).toHaveLength(1)
  })

  it('REGRESSION (Crash-Erkennung zu großzügig): a second, unrelated ChangeRequest targeting the same already-current spec version still runs its own migration', async () => {
    graph = diamondGraph()
    const spec2: ProjectSpecification = { ...spec, version: 2, status: 'human_approved' }
    ports.spec = (_id, version) => (version === 2 ? spec2 : spec)
    changeRequests = [approvedChangeRequest()]
    let councilCalls = 0
    ports.council = async () => {
      councilCalls++
      return '```json\n[{"replacesTaskId":"ROOT","id":"ROOT-2","requirementIds":[],"title":"Root v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}},' +
        '{"replacesTaskId":"HARD","id":"HARD-2","requirementIds":[],"title":"Hard v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    }
    const engine = new ProjectEngine(ports)
    await engine.applyChangeRequest('p', 'cr-1')
    expect(graph.specVersion).toBe(2)
    expect(councilCalls).toBe(1)

    // A second, independent CR that happens to target the same
    // resultingSpecVersion (already the graph's current version) but
    // affects a completely different task. Matching purely on specVersion
    // (the pre-fix condition) would have taken the crash-recovery shortcut
    // here and marked this "applied" without ever invalidating SIBLING or
    // asking the council for a replacement - caught in a self-review.
    changeRequests.push({
      id: 'cr-2', projectId: 'p', reason: 'Unrelated problem in SIBLING', affectedRequirementIds: [],
      affectedTaskIds: ['SIBLING'], proposedChanges: 'Different approach', severity: 'architecture',
      status: 'human_approved', createdAt: 0, resultingSpecVersion: 2
    })
    ports.council = async () => {
      councilCalls++
      return '```json\n[{"replacesTaskId":"SIBLING","id":"SIBLING-2","requirementIds":[],"title":"Sibling v2","description":"","dependencies":[],"scope":{"allowedPaths":[]}}]\n```'
    }
    await engine.applyChangeRequest('p', 'cr-2')

    expect(councilCalls).toBe(2)
    const sibling = graph.tasks.find(t => t.id === 'SIBLING')!
    expect(sibling.status).toBe('invalidated')
    expect(sibling.replacedByTaskId).toEqual(['SIBLING-2'])
    expect(changeRequests.find(c => c.id === 'cr-2')!.appliedAt).toBeDefined()
  })

  it('drives a needs_revalidation task through start() -> accept() back to accepted, reusing its original id', async () => {
    graph = diamondGraph()
    graph.tasks.find(t => t.id === 'SOFT')!.status = 'needs_revalidation'
    const engine = await configured()
    await engine.start('p', 'SOFT', roles)
    await completed(engine)
    expect((await engine.get('p')).attempts.at(-1)?.status).toBe('review')
    await engine.accept('p', 'SOFT')
    expect(graph.tasks.find(t => t.id === 'SOFT')!.status).toBe('accepted')
  })

  it('REGRESSION (Revalidierungsstart nach Limitänderung fälschlich wieder akzeptiert): a start rejected by the attempt limit never lets a later save silently re-accept the task', async () => {
    graph = diamondGraph()
    graph.tasks.find(t => t.id === 'SOFT')!.status = 'needs_revalidation'
    await configured() // primes `persisted` with commands/maxAttempts scaffolding
    // A real, already-integrated attempt from before the ChangeRequest
    // downgraded SOFT to needs_revalidation.
    persisted!.attempts.push({
      id: 'old-soft', taskId: 'SOFT', specVersion: 1, startedAt: 1, finishedAt: 1,
      status: 'accepted', implementerId: 'one', reviewerId: 'two',
      verification: [], reviews: [], events: [], commit: 'deadbeef'
    })
    const restarted = new ProjectEngine(ports)
    const checkCommand = { executable: process.execPath, args: ['-e', "if(require('fs').readFileSync('app.txt','utf8') !== 'working app')process.exit(1)"], timeoutMs: 10000 }
    await restarted.configure('p', [checkCommand], 1) // limit already met by the stale attempt

    await expect(restarted.start('p', 'SOFT', roles)).rejects.toThrow(/Versuchslimit/)
    // Must still be needs_revalidation, not corrupted to 'in_progress' with
    // no matching attempt - that corrupted in-between state is invisible to
    // saveExecution()'s invalidated/needs_revalidation skip-guard.
    expect(graph.tasks.find(t => t.id === 'SOFT')!.status).toBe('needs_revalidation')

    // Raising the limit and saving again (any unrelated action would do)
    // must not silently derive SOFT's status from the stale accepted
    // attempt - no new attempt/check has actually run.
    await restarted.configure('p', [checkCommand], 3)
    expect(graph.tasks.find(t => t.id === 'SOFT')!.status).toBe('needs_revalidation')
  })
})

describe('release iterations and atomic revalidation starts', { timeout: 60000 }, () => {
  it.each([false, true])('executes and releases a change request after release, including crash recovery (%s)', async crashBeforeStateSave => {
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    await engine.accept('p', 'T1'); await engine.finalReview('p')
    const first = await engine.get('p')
    await engine.release('p', first.releaseCommit!)
    spec = { ...spec, version: 2 }
    changeRequests = [{ id: 'cr', projectId: 'p', status: 'human_approved', affectedTaskIds: ['T1'], affectedRequirementIds: [], reason: 'New requirement', proposedChanges: 'Revise', severity: 'architecture', createdAt: 0, resultingSpecVersion: 2 }]
    const council = ports.council
    ports.council = async () => JSON.stringify([{ replacesTaskId: 'T1', id: 'T2', requirementIds: [], title: 'Replacement', description: '', dependencies: [], scope: { allowedPaths: [] } }])
    const save = ports.save
    if (crashBeforeStateSave) {
      ports.save = async (_state, _graph, reason) => {
        if (reason === 'ChangeRequestApplied') throw new Error('simulated crash')
        await save(_state, _graph, reason)
      }
      await expect(engine.applyChangeRequest('p', 'cr')).rejects.toThrow('simulated crash')
      ports.save = save
    } else await engine.applyChangeRequest('p', 'cr')
    const restarted = new ProjectEngine(ports)
    if (crashBeforeStateSave) await restarted.applyChangeRequest('p', 'cr')
    const resumed = await restarted.get('p')
    expect(resumed).toMatchObject({ phase: 'execution', sourceHead: first.releaseCommit, specVersion: 2 })
    expect(resumed.runId).not.toBe(first.runId)
    expect(resumed.releaseCommit).toBeUndefined()
    expect(resumed.finalVerdict).toBeUndefined()
    expect(resumed.finalVerification).toBeUndefined()
    expect(changeRequests[0].appliedAt).toBeDefined()
    ports.council = council
    const baseExecutor = ports.executor('one')
    ports.executor = () => ({ ...baseExecutor, startTask: (task, options) => {
      const handle = baseExecutor.startTask(task, options)
      return { ...handle, events: (async function* () {
        if (task.permissionTier !== 'read-only') await writeFile(join(task.workingDirectory, 'revision.txt'), 'new requirement')
        yield* handle.events
      })() }
    } })
    await restarted.start('p', 'T2', roles); await completed(restarted)
    await restarted.accept('p', 'T2'); await restarted.finalReview('p')
    await restarted.release('p', (await restarted.get('p')).releaseCommit!)
    expect(await readFile(join(graph.workingDirectory!, 'revision.txt'), 'utf8')).toBe('new requirement')
    expect((await restarted.get('p')).phase).toBe('done')
  })

  it.each([false, true])('uses the last released commit as the next baseline and detects external changes (%s)', async externalChange => {
    const engine = await configured()
    await engine.start('p', 'T1', roles); await completed(engine)
    await engine.accept('p', 'T1'); await engine.finalReview('p')
    const first = await engine.get('p')
    await engine.release('p', first.releaseCommit!)
    if (externalChange) {
      await writeFile(join(graph.workingDirectory!, 'external.txt'), 'unrelated change')
      execFileSync('git', ['add', 'external.txt'], { cwd: graph.workingDirectory! })
      execFileSync('git', ['commit', '-m', 'External change'], { cwd: graph.workingDirectory! })
    }
    spec = { ...spec, version: 2 }
    graph = { ...graph, specVersion: 2, tasks: [{ ...graph.tasks[0], id: 'T2', specVersion: 2, status: 'pending' }] }
    await engine.adoptApprovedPlan('p')
    expect((await engine.get('p')).sourceHead).toBe(first.releaseCommit)
    const baseExecutor = ports.executor('one')
    ports.executor = () => ({ ...baseExecutor, startTask: (task, options) => {
      const handle = baseExecutor.startTask(task, options)
      return { ...handle, events: (async function* () {
        if (task.permissionTier !== 'read-only') await writeFile(join(task.workingDirectory, 'feature.txt'), 'version two')
        yield* handle.events
      })() }
    } })
    // The new baseline must survive a restart, not only the in-memory state.
    const restarted = new ProjectEngine(ports)
    await restarted.start('p', 'T2', roles); await completed(restarted)
    await restarted.accept('p', 'T2'); await restarted.finalReview('p')
    const second = await restarted.get('p')
    expect(second.releaseCommit).not.toBe(first.releaseCommit)
    if (externalChange) {
      await expect(restarted.release('p', second.releaseCommit!)).rejects.toThrow(/Zielbranch wurde/)
      await expect(readFile(join(graph.workingDirectory!, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await restarted.release('p', second.releaseCommit!)
      expect((await restarted.get('p')).phase).toBe('done')
      expect(await readFile(join(graph.workingDirectory!, 'feature.txt'), 'utf8')).toBe('version two')
    }
  })

  it('allows only one concurrent revalidation start and aborts that attempt', async () => {
    graph.tasks[0].status = 'needs_revalidation'
    const engine = await configured()
    ports.graph = () => structuredClone(graph)
    let finish!: () => void
    const running = new Promise<void>(resolve => { finish = resolve })
    const execute = vi.spyOn(engine as any, 'execute').mockImplementation(() => running)
    try {
      const results = await Promise.allSettled([engine.start('p', 'T1', roles), engine.start('p', 'T1', roles)])
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
      expect((await engine.get('p')).attempts).toHaveLength(1)
      expect(graph.tasks[0].status).toBe('in_progress')
      expect(execute).toHaveBeenCalledTimes(1)
      engine.abort('p')
      expect((execute.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
    } finally { finish(); await new Promise(resolve => setTimeout(resolve, 20)); execute.mockRestore() }
  })

  it('keeps revalidation pending after a failed start save and releases the project lock', async () => {
    graph.tasks[0].status = 'needs_revalidation'
    const engine = await configured()
    ports.graph = () => structuredClone(graph)
    const originalSave = ports.save
    ports.save = async () => { throw new Error('disk full') }
    await expect(engine.start('p', 'T1', roles)).rejects.toThrow('disk full')
    expect(graph.tasks[0].status).toBe('needs_revalidation')
    expect(persisted!.attempts).toHaveLength(0)
    ports.save = originalSave
    await engine.configure('p', persisted!.commands, 3)
    expect(graph.tasks[0].status).toBe('needs_revalidation')
  })
})

describe('missing tool installation decisions', { timeout: 60000 }, () => {
  it.each(['approve', 'decline', 'abort'] as const)('%s unblocks the paused attempt', async decision => {
    const engine = new ProjectEngine(ports)
    const missingExecutable = join(dir, 'not-installed-tool.exe')
    await engine.configure('p', [{ executable: missingExecutable, args: [], timeoutMs: 1000 }], 3)
    await engine.start('p', 'T1', roles)
    await vi.waitFor(async () => expect((await engine.get('p')).attempts[0].status).toBe('awaiting_install'), { timeout: 45000, interval: 100 })
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.pendingInstallAction).toEqual({ executable: missingExecutable, suggestedCommand: undefined })
    expect(graph.tasks[0].status).toBe('in_progress')
    const marker = join(attempt.worktree!.path, 'installation marker.txt')
    if (decision === 'abort') engine.abort('p')
    else await engine.respondToInstallRequest('p', attempt.id, decision === 'approve'
      ? { approved: true, command: { executable: process.execPath, args: ['-e', "require('fs').writeFileSync(process.argv[1], 'installed')", marker], timeoutMs: 10000 } }
      : { approved: false })
    await vi.waitFor(async () => expect((await engine.get('p')).attempts[0].finishedAt).toBeDefined(), { timeout: 45000, interval: 100 })
    await new Promise(resolve => setTimeout(resolve, 20))
    const finished = (await engine.get('p')).attempts[0]
    expect(finished.status).toBe(decision === 'abort' ? 'paused' : 'failed') // Cancellation preserves a resumable checkpoint.
    if (decision === 'approve') expect(await readFile(marker, 'utf8')).toBe('installed')
    else await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    if (decision === 'abort') expect(finished.error).toMatch(/Abgebrochen/)
    else expect(finished.pendingInstallAction).toBeUndefined()
  })
})

describe('permission elevation on denial (Taskgraph-Ausführung only)', { timeout: 60000 }, () => {
  it('pauses the attempt at awaiting_permission with the detected denied actions once the implementer turn completes', async () => {
    denyOnce = ['RunCommand']
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('awaiting_permission')
    expect(attempt.pendingPermissionActions).toEqual(['RunCommand'])
  })

  it('granting resumes the same agent session via resumeSession() at tier "full" and completes normally', async () => {
    denyOnce = ['RunCommand']
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    const attemptId = (await engine.get('p')).attempts[0].id

    await engine.respondToPermissionRequest('p', attemptId, true)
    // Waiting for !== 'awaiting_permission' alone catches the transient
    // 'running' reset that happens before the resumed call even starts -
    // finishedAt is only set once execute() has truly completed (success or
    // failure), so it's the real completion signal here.
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.finishedAt).toBeDefined(), { timeout: 45000, interval: 100 })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(lastResumeCall).toEqual({ sessionId: 'sess-1', tier: 'full' })
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('review')
    expect(attempt.pendingPermissionActions).toBeUndefined()
    expect(await readFile(join(attempt.worktree!.path, 'app.txt'), 'utf-8')).toBe('working app')
  })

  it('denying leaves the attempt to proceed with the original (unelevated) outcome instead of hanging', async () => {
    denyOnce = ['RunCommand']
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await completed(engine)
    const attemptId = (await engine.get('p')).attempts[0].id

    await engine.respondToPermissionRequest('p', attemptId, false)
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.finishedAt).toBeDefined(), { timeout: 45000, interval: 100 })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(lastResumeCall).toBeUndefined()
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).not.toBe('awaiting_permission')
    expect(attempt.pendingPermissionActions).toBeUndefined()
  })

  it('aborting while awaiting permission resolves cleanly ("Abgebrochen.") instead of hanging forever', async () => {
    denyOnce = ['RunCommand']
    const engine = await configured()
    await engine.start('p', 'T1', roles)
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.status).toBe('awaiting_permission'), { timeout: 45000, interval: 100 })

    engine.abort('p')
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.status).not.toBe('awaiting_permission'), { timeout: 45000, interval: 100 })

    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('paused')
    expect(attempt.runtime?.failureKind).toBe('cancelled')
    expect(attempt.error).toMatch(/Abgebrochen/)
  })

  it('REGRESSION (restart recovery): an attempt frozen at awaiting_permission after a restart is treated the same as an abandoned running attempt', async () => {
    const engine = await configured()
    persisted!.attempts.push({ id: 'old', taskId: 'T1', specVersion: 1, startedAt: 1, status: 'awaiting_permission',
      pendingPermissionActions: ['RunCommand'], implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: ['evidence'] })
    const restarted = new ProjectEngine(ports)
    const state = await restarted.get('p')
    expect(state.attempts[0]).toMatchObject({ status: 'interrupted', events: ['evidence'] })
    expect(state.attempts[0].pendingPermissionActions).toBeUndefined()
  })
})

describe('proactive permission elevation before implement/fix (Claude Code & Antigravity only)', { timeout: 60000 }, () => {
  it.each(['claude-code-cli', 'google-antigravity-cli'])(
    'requests full access before the very first %s implement call, without a wasted read-write turn first', async implementerId => {
      const original = ports.executor('one')
      const tiers: (string | undefined)[] = []
      ports.executor = () => ({ ...original, startTask: (task, options) => {
        tiers.push(task.permissionTier)
        return original.startTask(task, options)
      } })
      const engine = await configured()
      await engine.start('p', 'T1', { ...roles, implementerId })
      await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.status).toBe('awaiting_permission'), { timeout: 45000, interval: 100 })
      // The elevation request happens BEFORE any agent call - nothing was
      // denied, no wasted read-write turn ran yet.
      expect(tiers).toEqual([])
      const attempt = (await engine.get('p')).attempts[0]
      expect(attempt.pendingPermissionActions).toEqual(['Shell-/Terminal-Befehle'])

      await engine.respondToPermissionRequest('p', attempt.id, true)
      // As with the reactive-elevation tests: waiting for !== 'awaiting_permission'
      // alone catches the transient 'running' reset before the actual call
      // even starts - finishedAt is only set once execute() has truly
      // completed, so it's the real completion signal here.
      await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.finishedAt).toBeDefined(), { timeout: 45000, interval: 100 })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(tiers[0]).toBe('full')
      expect((await engine.get('p')).attempts[0].status).toBe('review')
    }
  )

  it('does not ask Codex up front - its read-write tier already allows sandboxed shell access', async () => {
    const original = ports.executor('one')
    const tiers: (string | undefined)[] = []
    ports.executor = () => ({ ...original, startTask: (task, options) => {
      tiers.push(task.permissionTier)
      return original.startTask(task, options)
    } })
    const engine = await configured()
    await engine.start('p', 'T1', { ...roles, implementerId: 'openai-codex-cli' })
    await completed(engine)
    expect(tiers[0]).toBe('read-write')
    const attempt = (await engine.get('p')).attempts[0]
    expect(attempt.status).toBe('review')
    expect(attempt.pendingPermissionActions).toBeUndefined()
  })

  it('declining the proactive request leaves the attempt to proceed at read-write instead of hanging', async () => {
    const original = ports.executor('one')
    const tiers: (string | undefined)[] = []
    ports.executor = () => ({ ...original, startTask: (task, options) => {
      tiers.push(task.permissionTier)
      return original.startTask(task, options)
    } })
    const engine = await configured()
    await engine.start('p', 'T1', { ...roles, implementerId: 'claude-code-cli' })
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.status).toBe('awaiting_permission'), { timeout: 45000, interval: 100 })
    const attempt = (await engine.get('p')).attempts[0]

    await engine.respondToPermissionRequest('p', attempt.id, false)
    await vi.waitFor(async () => expect((await engine.get('p')).attempts.at(-1)?.finishedAt).toBeDefined(), { timeout: 45000, interval: 100 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(tiers[0]).toBe('read-write')
    expect((await engine.get('p')).attempts[0].pendingPermissionActions).toBeUndefined()
  })
})

describe('previous-attempt failure context (previousAttemptsSummary)', { timeout: 60000 }, () => {
  it('REGRESSION (Versuche lernten nichts voneinander): a fresh attempt for a task with a prior failed attempt receives a summary of what went wrong', async () => {
    const engine = await configured()
    persisted!.attempts.push({
      id: 'old-failed', taskId: 'T1', specVersion: 1, startedAt: 1, finishedAt: 2, status: 'failed',
      implementerId: 'one', reviewerId: 'two', verification: [], events: [],
      error: 'Prüfungen oder Reviews weiterhin fehlgeschlagen.',
      reviews: [{ verdict: 'fail', resolution: 'implementation', findings: [{ severity: 'medium', message: 'Es fehlen Verhaltenstests für die Verträge.' }] }]
    })
    const restarted = new ProjectEngine(ports)
    await restarted.start('p', 'T1', roles)
    await completed(restarted)
    const attempt = (await restarted.get('p')).attempts.at(-1)!
    expect(attempt.context).toContain('Vorherige Versuche')
    expect(attempt.context).toContain('Es fehlen Verhaltenstests für die Verträge.')
  })

  it('does not add a history block when resuming a paused attempt, even though it was included when that attempt first started', async () => {
    await configured() // sets up persisted.commands via the default (unmodified) executor
    persisted!.attempts.push({
      id: 'old-failed', taskId: 'T1', specVersion: 1, startedAt: 1, finishedAt: 2, status: 'failed',
      implementerId: 'one', reviewerId: 'two', verification: [], events: [],
      error: 'Vorheriger Fehler', reviews: [{ verdict: 'fail', resolution: 'implementation', findings: [{ severity: 'high', message: 'EINZIGARTIGER_MARKIERUNGSTEXT' }] }]
    })
    const original = ports.executor('one')
    ports.executor = () => ({ ...original, startTask: () => ({ taskId: 'auth', events: (async function* () {
      yield { type: 'error' as const, message: 'Not logged in · Please run /login' }
    })() }) })
    const engine = new ProjectEngine(ports)
    await engine.start('p', 'T1', roles)
    await completed(engine)
    let attempt = (await engine.get('p')).attempts.find(a => a.id !== 'old-failed')!
    expect(attempt.status).toBe('paused')
    // The fresh attempt's own first start DID get the history block.
    expect(attempt.context).toContain('EINZIGARTIGER_MARKIERUNGSTEXT')

    ports.executor = () => original
    const restarted = new ProjectEngine(ports)
    await restarted.start('p', 'T1', { implementerId: 'one', reviewerId: 'two' })
    await completed(restarted)
    attempt = (await restarted.get('p')).attempts.find(a => a.id !== 'old-failed')!
    expect(attempt.status).toBe('review')
    // Resuming the SAME (now-paused) attempt recomputes its prompt without
    // the history block, overwriting the version that had it.
    expect(attempt.context).not.toContain('EINZIGARTIGER_MARKIERUNGSTEXT')
  })
})
