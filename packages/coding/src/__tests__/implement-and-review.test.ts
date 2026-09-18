import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '../process/spawn-process'
import { runImplementAndReview, type WorkflowEvent } from '../orchestrator/implement-and-review'
import type {
  CodingExecutor,
  CodingExecutorCapabilities,
  CodingExecutorEvent,
  CodingExecutorHandle,
  CodingTaskSpec,
  CodingTaskStatus,
  ExecutorAvailability,
  StartTaskOptions
} from '../contracts'

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const { exitCode } = spawnProcess(command, args, { cwd })
  await exitCode
}

async function initRepoWithCommit(dir: string): Promise<void> {
  await run('git', ['init'], dir)
  await run('git', ['config', 'user.email', 'test@example.com'], dir)
  await run('git', ['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'app.txt'), 'original\n')
  await run('git', ['add', '-A'], dir)
  await run('git', ['commit', '-m', 'initial'], dir)
}

/** A CodingExecutor test double: each call records the spec it received and runs a supplied handler. */
class MockExecutor implements CodingExecutor {
  readonly id: string
  calls: CodingTaskSpec[] = []

  constructor(
    id: string,
    private handler: (spec: CodingTaskSpec, options?: StartTaskOptions) => AsyncGenerator<CodingExecutorEvent>
  ) {
    this.id = id
  }

  async detect(): Promise<ExecutorAvailability> {
    return { installed: true, authStatus: 'authenticated' }
  }

  capabilities(): CodingExecutorCapabilities {
    return { resumeSession: false, fileEditing: true, shellAccess: true }
  }

  startTask(spec: CodingTaskSpec, options?: StartTaskOptions): CodingExecutorHandle {
    this.calls.push(spec)
    return { taskId: `task-${this.calls.length}`, events: this.handler(spec, options) }
  }

  streamEvents(): AsyncIterable<CodingExecutorEvent> | undefined {
    return undefined
  }

  getStatus(): CodingTaskStatus | undefined {
    return undefined
  }

  abort(): void {}
}

async function* okRun(summary: string): AsyncGenerator<CodingExecutorEvent> {
  yield { type: 'start', taskId: 't' }
  yield { type: 'text', text: summary }
  yield { type: 'done', summary }
}

async function* failingRun(message: string): AsyncGenerator<CodingExecutorEvent> {
  yield { type: 'start', taskId: 't' }
  yield { type: 'error', message }
}

/**
 * Mimics a real executor's actual abort behavior (see e.g.
 * openai-codex-cli.ts's streamProcess): blocks until the signal fires, then
 * returns WITHOUT yielding a `done` or `error` event - a killed process's
 * stdout just ends. If the orchestrator's own post-stage `signal?.aborted`
 * check didn't exist, this would look identical to "ran with no output".
 */
async function* hangingRun(options?: StartTaskOptions): AsyncGenerator<CodingExecutorEvent> {
  yield { type: 'start', taskId: 't' }
  await new Promise<void>((resolve) => {
    if (options?.signal?.aborted) return resolve()
    options?.signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function collect(events: AsyncIterable<WorkflowEvent>): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('runImplementAndReview', () => {
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'implement-review-'))
    await initRepoWithCommit(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs implement -> review -> fix -> finalReview and succeeds when everything completes', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('Feature implementiert.')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('Sieht gut aus, ein kleiner Punkt: Fehlerbehandlung fehlt.')
    })

    const handle = runImplementAndReview({
      task: 'Baue Feature X',
      workingDirectory: dir,
      implementer,
      reviewer
    })
    const events = await collect(handle.events)

    const stages = events.filter((e) => e.kind === 'stage_started').map((e) => e.stage)
    expect(stages).toEqual(['implement', 'review', 'fix', 'finalReview'])

    const done = events.find((e) => e.kind === 'workflow_done')
    expect(done).toEqual({ kind: 'workflow_done', success: true })

    // Implementer ran twice (implement + fix), reviewer twice (review + finalReview).
    expect(implementer.calls).toHaveLength(2)
    expect(reviewer.calls).toHaveLength(2)
  })

  it('checks the fix itself instead of trusting it blindly: finalReview runs read-only after fix, sees the original findings and the post-fix diff', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('Fehlerbehandlung fehlt komplett.')
    })

    await collect(
      runImplementAndReview({
        task: 'Baue Feature X',
        workingDirectory: dir,
        implementer,
        reviewer,
        permissionTier: 'full'
      }).events
    )

    expect(reviewer.calls).toHaveLength(2)
    const finalReviewCall = reviewer.calls[1]
    expect(finalReviewCall.permissionTier).toBe('read-only')
    expect(finalReviewCall.prompt).toContain('Baue Feature X')
    expect(finalReviewCall.prompt).toContain('Fehlerbehandlung fehlt komplett.')
    expect(finalReviewCall.prompt).toContain('.ai-council-review.diff')
  })

  it('stops after fix if the final review fails', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    let reviewerCallCount = 0
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      reviewerCallCount += 1
      if (reviewerCallCount === 2) {
        yield* failingRun('final review crashed')
      } else {
        yield* okRun('ok')
      }
    })

    const events = await collect(
      runImplementAndReview({ task: 'x', workingDirectory: dir, implementer, reviewer }).events
    )

    expect(events.at(-1)).toEqual({
      kind: 'workflow_done',
      success: false,
      reason: 'Abschlussprüfung ist fehlgeschlagen.'
    })
    // Implement + fix both ran; only the final review failed.
    expect(implementer.calls).toHaveLength(2)
  })

  it('points the reviewer prompt at a diff file instead of inlining the diff', async () => {
    // Caught live: inlining a real diff in the reviewer's prompt blew past
    // the reviewer CLI's command-line length limit and failed the whole
    // workflow ("Die Befehlszeile ist zu lang."). The diff must be handed
    // over as a file reference instead, not inline text.
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('ok')
    })

    await collect(
      runImplementAndReview({ task: 'Baue Feature X', workingDirectory: dir, implementer, reviewer }).events
    )

    expect(reviewer.calls[0].prompt).toContain('app.txt')
    expect(reviewer.calls[0].prompt).toContain('Baue Feature X')
    expect(reviewer.calls[0].prompt).toContain('.ai-council-review.diff')
    expect(reviewer.calls[0].prompt).not.toContain('-original')
  })

  it('writes the real diff content to the diff file while the reviewer runs, and deletes it afterwards', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    let diffFileContentDuringReview = ''
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      diffFileContentDuringReview = readFileSync(join(dir, '.ai-council-review.diff'), 'utf-8')
      yield* okRun('ok')
    })

    await collect(runImplementAndReview({ task: 'x', workingDirectory: dir, implementer, reviewer }).events)

    expect(diffFileContentDuringReview).toContain('-original')
    expect(diffFileContentDuringReview).toContain('+implemented')
    expect(existsSync(join(dir, '.ai-council-review.diff'))).toBe(false)
  })

  it('always runs the reviewer as read-only, regardless of the requested permission tier', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('ok')
    })

    await collect(
      runImplementAndReview({
        task: 'x',
        workingDirectory: dir,
        implementer,
        reviewer,
        permissionTier: 'full'
      }).events
    )

    expect(reviewer.calls[0].permissionTier).toBe('read-only')
    expect(implementer.calls[0].permissionTier).toBe('full')
  })

  it('feeds the review findings into the fix prompt', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('Fehlerbehandlung fehlt komplett.')
    })

    await collect(
      runImplementAndReview({ task: 'Baue Feature X', workingDirectory: dir, implementer, reviewer }).events
    )

    expect(implementer.calls[1].prompt).toContain('Fehlerbehandlung fehlt komplett.')
  })

  it('stops after implement if the implementer fails, never calling the reviewer', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      yield* failingRun('boom')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('ok')
    })

    const events = await collect(
      runImplementAndReview({ task: 'x', workingDirectory: dir, implementer, reviewer }).events
    )

    expect(events.at(-1)).toEqual({
      kind: 'workflow_done',
      success: false,
      reason: 'Implementierung ist fehlgeschlagen.'
    })
    expect(reviewer.calls).toHaveLength(0)
  })

  it('stops after implement if nothing actually changed in the repo', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      // Doesn't touch any file.
      yield* okRun('Ich habe nichts geändert.')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('ok')
    })

    const events = await collect(
      runImplementAndReview({ task: 'x', workingDirectory: dir, implementer, reviewer }).events
    )

    expect(events.at(-1)).toMatchObject({ kind: 'workflow_done', success: false, noChanges: true })
    expect(reviewer.calls).toHaveLength(0)
  })

  it('stops after review if the reviewer fails, never running the fix step', async () => {
    const implementer = new MockExecutor('impl', async function* (_spec) {
      writeFileSync(join(dir, 'app.txt'), 'implemented\n')
      yield* okRun('done')
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* failingRun('review crashed')
    })

    const events = await collect(
      runImplementAndReview({ task: 'x', workingDirectory: dir, implementer, reviewer }).events
    )

    expect(events.at(-1)).toEqual({ kind: 'workflow_done', success: false, reason: 'Review ist fehlgeschlagen.' })
    expect(implementer.calls).toHaveLength(1)
  })

  it('REGRESSION (silent hang on abort): aborting mid-workflow always yields a final workflow_done event', async () => {
    // Caught live: aborting a workflow whose current stage was genuinely
    // stuck (a real hung network read inside an executor's CLI process)
    // killed the process, but the UI never showed a final result - just
    // the "Abbrechen" button disappearing, then nothing. A real executor's
    // event stream ends silently (no done/error event) once its process is
    // killed; the orchestrator's own post-stage `signal?.aborted` check is
    // the only thing that turns that into a real workflow_done event - and
    // it was never actually exercised by a test, since the shared
    // MockExecutor ignored the `options`/signal it was given until now.
    let implementCalls = 0
    const implementer = new MockExecutor('impl', async function* (_spec, options) {
      implementCalls += 1
      if (implementCalls === 1) {
        writeFileSync(join(dir, 'app.txt'), 'implemented\n')
        yield* okRun('done')
      } else {
        yield* hangingRun(options)
      }
    })
    const reviewer = new MockExecutor('rev', async function* (_spec) {
      yield* okRun('ok')
    })

    const controller = new AbortController()
    const handle = runImplementAndReview(
      { task: 'x', workingDirectory: dir, implementer, reviewer },
      { signal: controller.signal }
    )

    const events: WorkflowEvent[] = []
    const iterator = handle.events[Symbol.asyncIterator]()
    let result = await iterator.next()
    while (!result.done) {
      events.push(result.value)
      if (result.value.kind === 'stage_started' && result.value.stage === 'fix') {
        controller.abort()
      }
      result = await iterator.next()
    }

    expect(events.at(-1)).toEqual({ kind: 'workflow_done', success: false, reason: 'Abgebrochen.' })
  })

  describe('pipeline configuration (fixed toolbox, not free branching)', () => {
    it('reviewAndFix: false runs only the implement stage', async () => {
      const implementer = new MockExecutor('impl', async function* (_spec) {
        writeFileSync(join(dir, 'app.txt'), 'implemented\n')
        yield* okRun('done')
      })
      const reviewer = new MockExecutor('rev', async function* (_spec) {
        yield* okRun('ok')
      })

      const events = await collect(
        runImplementAndReview({
          task: 'x',
          workingDirectory: dir,
          implementer,
          reviewer,
          pipeline: { reviewAndFix: false }
        }).events
      )

      const stages = events.filter((e) => e.kind === 'stage_started').map((e) => e.stage)
      expect(stages).toEqual(['implement'])
      expect(events.at(-1)).toEqual({ kind: 'workflow_done', success: true })
      expect(implementer.calls).toHaveLength(1)
      expect(reviewer.calls).toHaveLength(0)
    })

    it('finalReview: false stops after the first fix, skipping the final check', async () => {
      const implementer = new MockExecutor('impl', async function* (_spec) {
        writeFileSync(join(dir, 'app.txt'), 'implemented\n')
        yield* okRun('done')
      })
      const reviewer = new MockExecutor('rev', async function* (_spec) {
        yield* okRun('ok')
      })

      const events = await collect(
        runImplementAndReview({
          task: 'x',
          workingDirectory: dir,
          implementer,
          reviewer,
          pipeline: { finalReview: false }
        }).events
      )

      const stages = events.filter((e) => e.kind === 'stage_started').map((e) => e.stage)
      expect(stages).toEqual(['implement', 'review', 'fix'])
      expect(events.at(-1)).toEqual({ kind: 'workflow_done', success: true })
      expect(implementer.calls).toHaveLength(2)
      expect(reviewer.calls).toHaveLength(1)
    })

    it('secondReviewRound: true runs a second review+fix cycle (tagged review2/fix2) before the final check', async () => {
      const implementer = new MockExecutor('impl', async function* (_spec) {
        writeFileSync(join(dir, 'app.txt'), 'implemented\n')
        yield* okRun('done')
      })
      const reviewer = new MockExecutor('rev', async function* (_spec) {
        yield* okRun('ok')
      })

      const events = await collect(
        runImplementAndReview({
          task: 'x',
          workingDirectory: dir,
          implementer,
          reviewer,
          pipeline: { secondReviewRound: true }
        }).events
      )

      const stages = events.filter((e) => e.kind === 'stage_started').map((e) => e.stage)
      expect(stages).toEqual(['implement', 'review', 'fix', 'review2', 'fix2', 'finalReview'])
      expect(events.at(-1)).toEqual({ kind: 'workflow_done', success: true })
      // implement + fix + fix2
      expect(implementer.calls).toHaveLength(3)
      // review + review2 + finalReview
      expect(reviewer.calls).toHaveLength(3)
    })
  })
})
