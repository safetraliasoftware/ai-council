import { describe, expect, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { GrokBuildCliExecutor } from '../executors/grok-build-cli'
import type { CodingExecutorEvent } from '../contracts'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI =
  process.platform === 'win32'
    ? join(here, 'fixtures', 'fake-grok.cmd')
    : join(here, 'fixtures', 'fake-grok.cjs')

async function collect(events: AsyncIterable<CodingExecutorEvent>): Promise<CodingExecutorEvent[]> {
  const out: CodingExecutorEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('GrokBuildCliExecutor', () => {
  let workDir: string

  it.each(['__RESULT_THEN_FAIL__', '__ERROR_RESULT__'])('does not report success for %s', async prompt => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt, workingDirectory: workDir })
    const events = await collect(handle.events)
    expect(events.some(e => e.type === 'error')).toBe(true)
    expect(events.some(e => e.type === 'done')).toBe(false)
    expect(executor.getStatus(handle.taskId)?.state).toBe('error')
  })

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('detect() reports not installed for a missing binary', async () => {
    const executor = new GrokBuildCliExecutor('this-binary-does-not-exist-xyz')
    const availability = await executor.detect()
    expect(availability.installed).toBe(false)
  })

  it('detect() reports installed + version + authenticated for the fake CLI', async () => {
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const availability = await executor.detect()
    expect(availability.installed).toBe(true)
    expect(availability.version).toContain('fake')
    expect(availability.authStatus).toBe('authenticated')
  })

  it('detect() reports unauthenticated when "grok models" says so', async () => {
    process.env.FAKE_GROK_UNAUTHENTICATED = '1'
    try {
      const executor = new GrokBuildCliExecutor(FAKE_CLI)
      const availability = await executor.detect()
      expect(availability.authStatus).toBe('unauthenticated')
    } finally {
      delete process.env.FAKE_GROK_UNAUTHENTICATED
    }
  })

  it('starts a process and streams text/done events', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: workDir })
    const events = await collect(handle.events)

    expect(events[0]).toEqual({ type: 'start', taskId: handle.taskId })
    expect(events.some((e) => e.type === 'status' && e.message === 'init')).toBe(true)
    const text = events
      .filter((e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('Hallo Welt')

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', summary: 'Hallo Welt', sessionId: 'sess-123', costUsd: 0.0042 })
    expect(executor.getStatus(handle.taskId)?.state).toBe('done')
  })

  it('gives immediate feedback when a command starts, then the real command event once it finishes', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__COMMAND_OK__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const statusIdx = events.findIndex((e) => e.type === 'status' && e.message === 'Führt aus: npm test')
    const commandIdx = events.findIndex((e) => e.type === 'command')
    expect(statusIdx).toBeGreaterThanOrEqual(0)
    expect(commandIdx).toBeGreaterThan(statusIdx)
    expect(events[commandIdx]).toMatchObject({ type: 'command', command: 'npm test', exitCode: 0 })
  })

  it('surfaces a non-zero exit code as an error event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__FAIL__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    expect((error as Extract<CodingExecutorEvent, { type: 'error' }>).message).toContain('simulated failure')
    expect(executor.getStatus(handle.taskId)?.state).toBe('error')
  })

  it('stderr is surfaced as a warning when the CLI exits cleanly without ever producing a result event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__EXIT_CLEAN_NO_RESULT__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const warning = events.find((e): e is Extract<CodingExecutorEvent, { type: 'warning' }> => e.type === 'warning')
    expect(warning?.message).toContain('some diagnostic grok printed')
    const done = events.find((e): e is Extract<CodingExecutorEvent, { type: 'done' }> => e.type === 'done')
    expect(done?.summary).toBe('')
    expect(executor.getStatus(handle.taskId)?.state).toBe('done')
  })

  it('aborts a running task and stops the process', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__HANG__', workingDirectory: workDir })
    const iterator = handle.events[Symbol.asyncIterator]()

    await iterator.next() // start
    await iterator.next() // first "still-running" status
    const abortedAt = Date.now()
    executor.abort(handle.taskId)

    let result = await iterator.next()
    while (!result.done) result = await iterator.next()
    const teardownMs = Date.now() - abortedAt

    expect(executor.getStatus(handle.taskId)?.state).toBe('aborted')
    expect(teardownMs).toBeLessThan(5000)
  }, 15000)

  it('rejects a working directory that does not exist', () => {
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    expect(() =>
      executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: join(tmpdir(), 'does-not-exist-xyz') })
    ).toThrow(/Arbeitsverzeichnis/)
  })

  it('CREDENTIAL LEAK CHECK: only the documented args are ever passed, nothing secret-shaped', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const argvStatus = events.find(
      (e): e is Extract<CodingExecutorEvent, { type: 'status' }> =>
        e.type === 'status' && e.message.startsWith('argv:')
    )
    expect(argvStatus).toBeDefined()
    const { argv, prompt } = JSON.parse(argvStatus!.message.slice('argv:'.length))
    expect(argv.slice(0, -2)).toEqual([
      '--output-format', 'streaming-messages-json', '--include-partial-messages', '--cwd', workDir
    ])
    expect(argv[argv.length - 2]).toBe('--prompt-file')
    expect(argv).not.toContain('-p')
    expect(prompt).toBe('__ECHO_ARGS__')
    expect(JSON.stringify({ argv, prompt })).not.toMatch(/xai-|api[_-]?key/i)
  })

  it('REGRESSION: a prompt starting with "-" (e.g. the Company Truth preamble) is never passed via argv', async () => {
    // Real bug caught live: clap (grok's Rust argument parser) misreads a
    // value starting with "-" right after a flag as another flag, e.g.
    // `-p "--- Unternehmenswissen ..."` failed with
    // "error: unexpected argument '--- Unternehmenswissen ...' found".
    // Fix: never pass the prompt via argv at all - always write it to a
    // file and pass --prompt-file, regardless of content or length.
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const dashPrompt = '--- Unternehmenswissen (verbindlich) ---\n__ECHO_ARGS__'
    const handle = executor.startTask({ prompt: dashPrompt, workingDirectory: workDir })
    const events = await collect(handle.events)

    expect(events.some((e) => e.type === 'error')).toBe(false)
    const argvStatus = events.find(
      (e): e is Extract<CodingExecutorEvent, { type: 'status' }> =>
        e.type === 'status' && e.message.startsWith('argv:')
    )
    expect(argvStatus).toBeDefined()
    const { argv, prompt } = JSON.parse(argvStatus!.message.slice('argv:'.length))
    expect(argv).not.toContain('-p')
    expect(argv).toContain('--prompt-file')
    expect(prompt).toBe(dashPrompt)
  })

  it('always bypasses permissions when a tier is set (never blocks on an unapprovable confirmation), and restricts via --tools instead; omits both when unset', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)

    async function argvFor(permissionTier?: 'read-only' | 'read-write' | 'full'): Promise<string[]> {
      const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir, permissionTier })
      const events = await collect(handle.events)
      const argvStatus = events.find(
        (e): e is Extract<CodingExecutorEvent, { type: 'status' }> =>
          e.type === 'status' && e.message.startsWith('argv:')
      )
      return JSON.parse(argvStatus!.message.slice('argv:'.length)).argv
    }

    expect(await argvFor(undefined)).not.toContain('--permission-mode')
    expect(await argvFor(undefined)).not.toContain('--tools')

    const readOnly = await argvFor('read-only')
    expect(readOnly).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    expect(readOnly).toContain('--tools')
    const readOnlyTools = readOnly[readOnly.indexOf('--tools') + 1].split(',')
    expect(readOnlyTools).not.toContain('write')
    expect(readOnlyTools).not.toContain('run_terminal_command')
    expect(readOnlyTools).toContain('web_fetch')

    const readWrite = await argvFor('read-write')
    expect(readWrite).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    const readWriteTools = readWrite[readWrite.indexOf('--tools') + 1].split(',')
    expect(readWriteTools).toContain('write')
    expect(readWriteTools).not.toContain('run_terminal_command')

    const full = await argvFor('full')
    expect(full).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    expect(full).not.toContain('--tools')
  })

  it('resumeSession() passes the session id through to --resume', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new GrokBuildCliExecutor(FAKE_CLI)
    const handle = executor.resumeSession('sess-xyz', { prompt: '__ECHO_ARGS__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const argvStatus = events.find(
      (e): e is Extract<CodingExecutorEvent, { type: 'status' }> =>
        e.type === 'status' && e.message.startsWith('argv:')
    )
    const { argv } = JSON.parse(argvStatus!.message.slice('argv:'.length))
    expect(argv).toEqual(expect.arrayContaining(['--resume', 'sess-xyz']))
  })

  it(
    'a too-long prompt is written to a file via --prompt-file instead of failing or being truncated',
    async () => {
      // Same Windows argv-length risk as google-antigravity-cli.ts, but
      // grok's own --prompt-file flag (confirmed via `grok --help`) is the
      // clean, documented way around it - no read-a-file-via-a-tool-call
      // indirection needed here.
      workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
      const executor = new GrokBuildCliExecutor(FAKE_CLI)
      const hugePrompt = `MARKER-START ${'x'.repeat(30001)} MARKER-END`
      const handle = executor.startTask({ prompt: hugePrompt, workingDirectory: workDir })
      const events = await collect(handle.events)

      expect(events.some((e) => e.type === 'error')).toBe(false)
      const done = events.find((e): e is Extract<CodingExecutorEvent, { type: 'done' }> => e.type === 'done')
      expect(done?.summary).toContain('MARKER-START')
      expect(done?.summary).toContain('MARKER-END')

      // The temp file must not linger anywhere reachable after the task ends.
      const leftovers = readdirSync(workDir).filter((f) => f.startsWith('.ai-council-task-'))
      expect(leftovers).toEqual([])
    }
  )
})
