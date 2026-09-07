import { describe, expect, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { OpenAiCodexCliExecutor } from '../executors/openai-codex-cli'
import type { CodingExecutorEvent } from '../contracts'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI =
  process.platform === 'win32'
    ? join(here, 'fixtures', 'fake-codex.cmd')
    : join(here, 'fixtures', 'fake-codex.cjs')

async function collect(events: AsyncIterable<CodingExecutorEvent>): Promise<CodingExecutorEvent[]> {
  const out: CodingExecutorEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('OpenAiCodexCliExecutor', () => {
  let workDir: string

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('detect() reports not installed for a missing binary', async () => {
    const executor = new OpenAiCodexCliExecutor('this-binary-does-not-exist-xyz')
    const availability = await executor.detect()
    expect(availability.installed).toBe(false)
  })

  it('detect() reports installed + version for the fake CLI', async () => {
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const availability = await executor.detect()
    expect(availability.installed).toBe(true)
    expect(availability.version).toContain('Fake Codex')
  })

  it('starts a process and maps text/command/file_change/done events per the verified schema', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: workDir })
    const events = await collect(handle.events)

    expect(events[0]).toEqual({ type: 'start', taskId: handle.taskId })

    const command = events.find((e) => e.type === 'command')
    expect(command).toMatchObject({ type: 'command', command: 'npm test', exitCode: 0 })

    const fileChanges = events.filter((e): e is Extract<CodingExecutorEvent, { type: 'file_change' }> =>
      e.type === 'file_change'
    )
    expect(fileChanges).toEqual([
      { type: 'file_change', path: 'src/a.ts', changeType: 'modified' },
      { type: 'file_change', path: 'src/b.ts', changeType: 'created' }
    ])

    const text = events.find((e) => e.type === 'text')
    expect(text).toMatchObject({ type: 'text', text: 'Fertig, Tests laufen.' })

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', summary: 'Fertig, Tests laufen.', sessionId: 'thread-abc' })
    expect(executor.getStatus(handle.taskId)?.state).toBe('done')
  })

  it('maps turn.failed to an error event', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__FAIL__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const error = events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ type: 'error', message: 'simulated codex failure' })
    expect(executor.getStatus(handle.taskId)?.state).toBe('error')
  })

  it('resumeSession() passes the session id through to `codex exec resume`', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const handle = executor.resumeSession('session-xyz', {
      prompt: '__RESUME_ECHO__',
      workingDirectory: workDir
    })
    const events = await collect(handle.events)

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', sessionId: 'resumed:session-xyz' })
  })

  it('aborts a running task and stops the process', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__HANG__', workingDirectory: workDir })
    const iterator = handle.events[Symbol.asyncIterator]()

    await iterator.next() // start
    await iterator.next() // first turn.started status
    const abortedAt = Date.now()
    executor.abort(handle.taskId)

    let result = await iterator.next()
    while (!result.done) result = await iterator.next()
    const teardownMs = Date.now() - abortedAt

    expect(executor.getStatus(handle.taskId)?.state).toBe('aborted')
    expect(teardownMs).toBeLessThan(5000)
  }, 15000)

  it('rejects a working directory that does not exist', () => {
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    expect(() =>
      executor.startTask({ prompt: '__STREAM_OK__', workingDirectory: join(tmpdir(), 'does-not-exist-xyz') })
    ).toThrow(/Arbeitsverzeichnis/)
  })

  it('CREDENTIAL LEAK CHECK: never sets CODEX_API_KEY and only passes documented args', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    expect(process.env.CODEX_API_KEY).toBeUndefined()

    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir })
    const events = await collect(handle.events)

    const textEvent = events.find(
      (e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text' && e.text.startsWith('argv:')
    )
    expect(textEvent).toBeDefined()
    const argv = JSON.parse(textEvent!.text.slice('argv:'.length))
    expect(argv).toEqual(['exec', '--json', '__ECHO_ARGS__'])
    expect(JSON.stringify(argv)).not.toMatch(/sk-|CODEX_API_KEY/i)
  })

  it('translates permissionTier into --sandbox, and omits it for read-only/unset', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)

    async function argvFor(permissionTier?: 'read-only' | 'read-write' | 'full'): Promise<string[]> {
      const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir, permissionTier })
      const events = await collect(handle.events)
      const textEvent = events.find(
        (e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text' && e.text.startsWith('argv:')
      )
      return JSON.parse(textEvent!.text.slice('argv:'.length))
    }

    expect(await argvFor(undefined)).toEqual(['exec', '--json', '__ECHO_ARGS__'])
    expect(await argvFor('read-only')).toEqual(['exec', '--json', '__ECHO_ARGS__'])
    expect(await argvFor('read-write')).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--json',
      '__ECHO_ARGS__'
    ])
    expect(await argvFor('full')).toEqual([
      'exec',
      '--sandbox',
      'danger-full-access',
      '--json',
      '__ECHO_ARGS__'
    ])
  })
})
