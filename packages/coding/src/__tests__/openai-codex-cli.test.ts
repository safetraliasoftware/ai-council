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
    const { argv, prompt } = JSON.parse(textEvent!.text.slice('argv:'.length))
    // The prompt itself now travels via stdin, not argv - see
    // spawn-process.ts's SpawnOptions.stdin doc for why.
    expect(argv).toEqual(['exec', '--json', '-'])
    expect(prompt).toBe('__ECHO_ARGS__')
    expect(JSON.stringify({ argv, prompt })).not.toMatch(/sk-|CODEX_API_KEY/i)
  })

  it('REGRESSION (globally-installed .cmd shim corrupting a prompt argument): the prompt travels via stdin, not argv, and survives shell-special characters intact', async () => {
    // This is the exact failure caught live: a review-stage prompt reached
    // the real codex CLI as if empty - it asked back for the task instead
    // of reading the diff file it was pointed at. Root cause: codex's
    // globally-installed .cmd shim (%APPDATA%\npm\codex.cmd, not inside
    // node_modules/.bin/) proxies its args through a *second* cmd.exe layer
    // via `%*`; cross-spawn's double-escaping heuristic only fires for
    // node_modules/.bin/ shims, so a sufficiently complex prompt argument
    // can still come out corrupted even with cross-spawn's normal escaping.
    // Fix: never put the prompt in argv at all - write it to stdin and pass
    // '-' instead, which codex documents as "read the prompt from stdin".
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)
    const dangerous =
      '__ECHO_ARGS__ if (a && b) { x |= 1 } // 100% done <ok> "quoted" \'single\' ^caret & echo pwned'
    const handle = executor.startTask({ prompt: dangerous, workingDirectory: workDir })
    const events = await collect(handle.events)

    const textEvent = events.find(
      (e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text' && e.text.startsWith('argv:')
    )
    expect(textEvent).toBeDefined()
    const { argv, prompt } = JSON.parse(textEvent!.text.slice('argv:'.length))
    expect(argv[argv.length - 1]).toBe('-')
    expect(prompt).toBe(dangerous)
  })

  it('translates every explicit permissionTier into --sandbox, including read-only', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)

    async function argvFor(permissionTier?: 'read-only' | 'read-write' | 'full'): Promise<string[]> {
      const handle = executor.startTask({ prompt: '__ECHO_ARGS__', workingDirectory: workDir, permissionTier })
      const events = await collect(handle.events)
      const textEvent = events.find(
        (e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text' && e.text.startsWith('argv:')
      )
      return JSON.parse(textEvent!.text.slice('argv:'.length)).argv
    }

    expect(await argvFor(undefined)).toEqual(['exec', '--json', '-'])
    expect(await argvFor('read-only')).toEqual(['exec', '--sandbox', 'read-only', '--json', '-'])
    expect(await argvFor('read-write')).toEqual(['exec', '--sandbox', 'workspace-write', '--json', '-'])
    expect(await argvFor('full')).toEqual(['exec', '--sandbox', 'danger-full-access', '--json', '-'])
  })

  it('REGRESSION (`codex exec resume` rejects `--sandbox`): resumeSession() passes the sandbox level as a -c config override instead', async () => {
    // Live-verified against the real CLI: `codex exec resume <id> --sandbox
    // workspace-write` fails with "unexpected argument '--sandbox' found"
    // before running anything - the resume subcommand has no --sandbox flag,
    // only startTask's plain `codex exec` does. `-c sandbox_mode="..."` is
    // the documented, live-confirmed equivalent that resume does accept.
    workDir = mkdtempSync(join(tmpdir(), 'coding-exec-'))
    const executor = new OpenAiCodexCliExecutor(FAKE_CLI)

    async function resumeArgvFor(permissionTier?: 'read-only' | 'read-write' | 'full'): Promise<string[]> {
      const handle = executor.resumeSession('session-xyz', {
        prompt: '__ECHO_ARGS__',
        workingDirectory: workDir,
        permissionTier
      })
      const events = await collect(handle.events)
      const textEvent = events.find(
        (e): e is Extract<CodingExecutorEvent, { type: 'text' }> => e.type === 'text' && e.text.startsWith('argv:')
      )
      return JSON.parse(textEvent!.text.slice('argv:'.length)).argv
    }

    expect(await resumeArgvFor(undefined)).toEqual(['exec', 'resume', 'session-xyz', '--json', '-'])
    expect(await resumeArgvFor('read-only')).toEqual([
      'exec', 'resume', 'session-xyz', '-c', 'sandbox_mode="read-only"', '--json', '-'
    ])
    expect(await resumeArgvFor('read-write')).toEqual([
      'exec',
      'resume',
      'session-xyz',
      '-c',
      'sandbox_mode="workspace-write"',
      '--json',
      '-'
    ])
    expect(await resumeArgvFor('full')).toEqual([
      'exec',
      'resume',
      'session-xyz',
      '-c',
      'sandbox_mode="danger-full-access"',
      '--json',
      '-'
    ])
    expect(await resumeArgvFor('read-write')).not.toContain('--sandbox')
  })
})
