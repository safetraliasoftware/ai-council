import { describe, expect, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { GoogleAntigravityCliExecutor } from '../executors/google-antigravity-cli'
import type { CodingExecutorEvent } from '../contracts'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI =
  process.platform === 'win32'
    ? join(here, 'fixtures', 'fake-agy.cmd')
    : join(here, 'fixtures', 'fake-agy.cjs')

async function collect(events: AsyncIterable<CodingExecutorEvent>): Promise<CodingExecutorEvent[]> {
  const out: CodingExecutorEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('GoogleAntigravityCliExecutor', () => {
  let workDir: string

  it('never publishes success when the process fails after its result event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__RESULT_THEN_FAIL__', workingDirectory: workDir })
    const events = await collect(handle.events)
    expect(events.some(e => e.type === 'done')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: 'late process failure' }))
    expect(executor.getStatus(handle.taskId)?.state).toBe('error')
  })

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('detect() reports not installed for a missing binary', async () => {
    const executor = new GoogleAntigravityCliExecutor('this-binary-does-not-exist-xyz')
    const availability = await executor.detect()
    expect(availability.installed).toBe(false)
  })

  it('detect() reports installed + version for the fake CLI', async () => {
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const availability = await executor.detect()
    expect(availability.installed).toBe(true)
    expect(availability.version).toContain('fake')
  })

  it('starts a process and streams text/done events', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: workDir })
    const events = await collect(handle.events)

    expect(events[0]).toEqual({ type: 'start', taskId: handle.taskId })
    expect(events.some((e) => e.type === 'status' && e.message === 'init')).toBe(true)

    const text = events.find((e) => e.type === 'text')
    expect(text).toMatchObject({ type: 'text', text: 'Hallo Welt' })

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', summary: 'Hallo Welt', sessionId: 'conv-123' })
    expect(executor.getStatus(handle.taskId)?.state).toBe('done')
  })

  it('gives immediate feedback when a command starts, then the real command event once it finishes', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__COMMAND_OK__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const statusIdx = events.findIndex((e) => e.type === 'status' && e.message === 'Führt aus: npm test')
    const commandIdx = events.findIndex((e) => e.type === 'command')
    expect(statusIdx).toBeGreaterThanOrEqual(0)
    expect(commandIdx).toBeGreaterThan(statusIdx)
    expect(events[commandIdx]).toMatchObject({ type: 'command', command: 'npm test', exitCode: 0 })
  })

  it('surfaces denied actions as a warning before done', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__DENIED__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const warning = events.find((e) => e.type === 'warning')
    expect(warning).toBeDefined()
    expect((warning as Extract<CodingExecutorEvent, { type: 'warning' }>).message).toContain('RunCommand')

    const command = events.find((e) => e.type === 'command')
    expect(command).toMatchObject({ type: 'command', command: 'rm -rf x', exitCode: 1 })

    const warningIdx = events.findIndex((e) => e.type === 'warning')
    const doneIdx = events.findIndex((e) => e.type === 'done')
    expect(warningIdx).toBeLessThan(doneIdx)
  })

  it('resumeSession() passes the conversation id through to --conversation', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.resumeSession('conv-xyz', { prompt: '__RESUME_ECHO__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', sessionId: 'resumed:conv-xyz' })
  })

  it('surfaces a non-zero exit code as an error event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__FAIL__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    expect((error as Extract<CodingExecutorEvent, { type: 'error' }>).message).toContain('simulated agy failure')
    expect(executor.getStatus(handle.taskId)?.state).toBe('error')
  })

  it('REGRESSION (leere Review-Antwort ohne Diagnose): stderr is surfaced as a warning when the CLI exits cleanly without ever producing a result event', async () => {
    // Caught live: a reviewer turn on this executor ended with no
    // recoverable JSON verdict, twice in a row ("Es liegt kein
    // Review-Urteil vor") - agy exited 0 but never emitted a `result`
    // event, and whatever it printed to stderr along the way was silently
    // discarded, leaving nothing to diagnose why. Surfacing it at least
    // gives a real clue instead of a bare empty "done".
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__EXIT_CLEAN_NO_RESULT__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const warning = events.find((e): e is Extract<CodingExecutorEvent, { type: 'warning' }> => e.type === 'warning')
    expect(warning?.message).toContain('never produced a result event')
    const done = events.find((e): e is Extract<CodingExecutorEvent, { type: 'done' }> => e.type === 'done')
    expect(done?.summary).toBe('')
    expect(executor.getStatus(handle.taskId)?.state).toBe('done')
  })

  it('aborts a running task and stops the process', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__HANG__', workingDirectory: workDir })
    const iterator = handle.events[Symbol.asyncIterator]()

    await iterator.next() // start
    await iterator.next() // first "still running" step_update
    const abortedAt = Date.now()
    executor.abort(handle.taskId)

    let result = await iterator.next()
    while (!result.done) result = await iterator.next()
    const teardownMs = Date.now() - abortedAt

    expect(executor.getStatus(handle.taskId)?.state).toBe('aborted')
    expect(teardownMs).toBeLessThan(5000)
  }, 15000)

  it('rejects a working directory that does not exist', () => {
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
    expect(() =>
      executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: join(tmpdir(), 'does-not-exist-xyz') })
    ).toThrow(/Arbeitsverzeichnis/)
  })

  it(
    'REGRESSION (raw "spawn ENAMETOOLONG" crash): a too-long prompt is written to a file and ' +
      'referenced with a short prompt instead of failing or being truncated',
    async () => {
      // Caught live: agy is a native .exe with no verified way to receive a
      // long prompt outside argv (unlike Claude/Codex, which pass it via
      // stdin) - a long enough prompt hit Windows' command-line length
      // limit and surfaced as a bare "spawn ENAMETOOLONG". Previously this
      // was turned into a clear error instead ("Aufgabe kürzen oder ohne
      // Antigravity ausführen") - but that failed this participant's whole
      // turn (and, separately, used to crash the entire multi-agent Council
      // round - see agent-participant.ts's own regression test). Verified
      // live against the real CLI that its own view_file tool reads an
      // arbitrary-length file in full and reasons over it correctly, so the
      // actual fix routes a too-long prompt through a file instead.
      workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
      const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)
      const hugePrompt = `MARKER-START ${'x'.repeat(30001)} MARKER-END`
      const handle = executor.startTask({ prompt: hugePrompt, workingDirectory: workDir })
      const events: CodingExecutorEvent[] = []
      let promptFile = ''
      for await (const event of handle.events) {
        events.push(event)
        if (event.type === 'text' && event.text.startsWith('prompt-file:')) {
          promptFile = event.text.slice('prompt-file:'.length)
          expect(existsSync(promptFile)).toBe(true)
          // A parallel reviewer can inspect the project while agy is active.
          expect(readdirSync(workDir)).toEqual([])
          expect(dirname(promptFile)).not.toBe(workDir)
        }
      }
      expect(promptFile).not.toBe('')
      expect(existsSync(dirname(promptFile))).toBe(false)
      expect(events.some((e) => e.type === 'error')).toBe(false)
      const done = events.find((e): e is Extract<CodingExecutorEvent, { type: 'done' }> => e.type === 'done')
      expect(done?.summary).toContain('MARKER-START')
      expect(done?.summary).toContain('MARKER-END')

      // The temp file must not linger in the user's real project directory.
      const leftovers = readdirSync(workDir).filter((f) => f.startsWith('.ai-council-task-'))
      expect(leftovers).toEqual([])
    }
  )

  it('CREDENTIAL LEAK CHECK: never sets GEMINI_API_KEY, permissionTier controls only --dangerously-skip-permissions', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
    const executor = new GoogleAntigravityCliExecutor(FAKE_CLI)

    async function argvFor(permissionTier?: 'read-only' | 'read-write' | 'full'): Promise<string[]> {
      const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir, permissionTier })
      const events = await collect(handle.events)
      const text = events.find(
        (e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text' && e.text.startsWith('argv:')
      )
      return JSON.parse(text!.text.slice('argv:'.length))
    }

    expect(await argvFor(undefined)).toEqual([
      '-p',
      '__ECHO_ARGS__',
      '--add-dir',
      workDir,
      '--output-format',
      'stream-json'
    ])
    expect(await argvFor('read-only')).toEqual([
      '-p',
      '__ECHO_ARGS__',
      '--add-dir',
      workDir,
      '--output-format',
      'stream-json'
    ])
    expect(await argvFor('read-write')).toEqual([
      '-p',
      '__ECHO_ARGS__',
      '--add-dir',
      workDir,
      '--output-format',
      'stream-json'
    ])
    expect(JSON.stringify(await argvFor('full'))).not.toMatch(/sk-|GEMINI_API_KEY/i)
  })
})
