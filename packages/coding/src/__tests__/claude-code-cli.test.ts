import { describe, expect, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ClaudeCodeCliExecutor } from '../executors/claude-code-cli'
import type { CodingExecutorEvent } from '../contracts'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI =
  process.platform === 'win32'
    ? join(here, 'fixtures', 'fake-claude.cmd')
    : join(here, 'fixtures', 'fake-claude.cjs')

async function collect(events: AsyncIterable<CodingExecutorEvent>): Promise<CodingExecutorEvent[]> {
  const out: CodingExecutorEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('ClaudeCodeCliExecutor', () => {
  let workDir: string

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('detect() reports not installed for a missing binary', async () => {
    const executor = new ClaudeCodeCliExecutor('this-binary-does-not-exist-xyz')
    const availability = await executor.detect()
    expect(availability.installed).toBe(false)
  })

  it('detect() reports installed + version + authenticated for the fake CLI', async () => {
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
    const availability = await executor.detect()
    expect(availability.installed).toBe(true)
    expect(availability.version).toContain('Fake Claude')
    expect(availability.authStatus).toBe('authenticated')
  })

  it('detect() reports unauthenticated when the CLI says so', async () => {
    process.env.FAKE_CLAUDE_AUTH_EXIT = '1'
    try {
      const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
      const availability = await executor.detect()
      expect(availability.authStatus).toBe('unauthenticated')
    } finally {
      delete process.env.FAKE_CLAUDE_AUTH_EXIT
    }
  })

  it('starts a process and streams text/done events', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
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

  it('surfaces denied tool calls as a warning and the attempted command as a command event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__DENIED_TOOLS__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const command = events.find((e) => e.type === 'command')
    expect(command).toMatchObject({ type: 'command', command: 'echo hi' })

    const warning = events.find((e) => e.type === 'warning')
    expect(warning).toBeDefined()
    expect((warning as Extract<CodingExecutorEvent, { type: 'warning' }>).message).toContain('Bash')
    expect((warning as Extract<CodingExecutorEvent, { type: 'warning' }>).message).toContain('Edit')

    // The warning must appear before "done" so the UI doesn't show a bare
    // "Fertig" with the explanation hidden after it.
    const warningIdx = events.findIndex((e) => e.type === 'warning')
    const doneIdx = events.findIndex((e) => e.type === 'done')
    expect(warningIdx).toBeLessThan(doneIdx)
  })

  it('surfaces a non-zero exit code as an error event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__FAIL__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    expect((error as Extract<CodingExecutorEvent, { type: 'error' }>).message).toContain('simulated failure')
    expect(executor.getStatus(handle.taskId)?.state).toBe('error')
  })

  it('aborts a running task and stops the process', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
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
    // The fake process has a 10s self-destruct safety net that only fires if
    // it was never actually killed. Finishing well under that proves abort()
    // tree-kills the real process instead of just detaching from a pipe that
    // happens to close later on its own.
    expect(teardownMs).toBeLessThan(5000)
  }, 15000)

  it('rejects a working directory that does not exist', () => {
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
    expect(() =>
      executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: join(tmpdir(), 'does-not-exist-xyz') })
    ).toThrow(/Arbeitsverzeichnis/)
  })

  it('CREDENTIAL LEAK CHECK: only the documented args are ever passed, nothing secret-shaped', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const argvStatus = events.find(
      (e): e is Extract<CodingExecutorEvent, { type: 'status' }> =>
        e.type === 'status' && e.message.startsWith('argv:')
    )
    expect(argvStatus).toBeDefined()
    const argv = JSON.parse(argvStatus!.message.slice('argv:'.length))
    expect(argv).toEqual([
      '-p',
      '__ECHO_ARGS__',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages'
    ])
    expect(JSON.stringify(argv)).not.toMatch(/sk-ant|sk-proj|api[_-]?key/i)
  })

  it('translates permissionTier into --allowedTools, and omits it when unset', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new ClaudeCodeCliExecutor(FAKE_CLI)

    async function argvFor(permissionTier?: 'read-only' | 'read-write' | 'full'): Promise<string[]> {
      const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir, permissionTier })
      const events = await collect(handle.events)
      const argvStatus = events.find(
        (e): e is Extract<CodingExecutorEvent, { type: 'status' }> =>
          e.type === 'status' && e.message.startsWith('argv:')
      )
      return JSON.parse(argvStatus!.message.slice('argv:'.length))
    }

    expect(await argvFor(undefined)).not.toContain('--allowedTools')
    expect(await argvFor('read-only')).toEqual(expect.arrayContaining(['--allowedTools', 'Read,Glob,Grep']))
    expect(await argvFor('read-write')).toEqual(
      expect.arrayContaining(['--allowedTools', 'Read,Glob,Grep,Edit,Write'])
    )
    expect(await argvFor('full')).toEqual(
      expect.arrayContaining(['--allowedTools', 'Read,Glob,Grep,Edit,Write,Bash'])
    )
  })
})
