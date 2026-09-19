import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodingExecutor, CodingExecutorEvent, CodingTaskSpec } from '@ai-council/coding'
import { toAgentCouncilParticipant } from '../agent-participant'

function fakeExecutor(
  events: CodingExecutorEvent[],
  onStartTask?: (spec: CodingTaskSpec) => void
): CodingExecutor {
  return {
    id: 'fake-executor',
    async detect() {
      return { installed: true, authStatus: 'authenticated' }
    },
    capabilities: () => ({ resumeSession: false, fileEditing: true, shellAccess: true }),
    startTask(spec) {
      onStartTask?.(spec)
      async function* gen(): AsyncGenerator<CodingExecutorEvent> {
        for (const e of events) yield e
      }
      return { taskId: 'fake-task', events: gen() }
    },
    streamEvents: () => undefined,
    getStatus: () => undefined,
    abort: () => {}
  }
}

async function collect(
  logicalProvider: 'anthropic' | 'openai' | 'gemini',
  executor: CodingExecutor,
  workingDirectory: string
) {
  const participant = toAgentCouncilParticipant(logicalProvider, executor, workingDirectory)
  const events = []
  for await (const e of participant.generate({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
  return events
}

describe('toAgentCouncilParticipant', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-participant-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('preserves reported usage without inventing missing or invalid measurements', async () => {
    const events = await collect('openai', fakeExecutor([
      { type: 'done', summary: 'answer', inputTokens: 100, outputTokens: 20, costUsd: 0 }
    ]), dir)
    expect(events.at(-1)).toEqual({ type: 'done', result: { text: 'answer', usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 } } })
    const invalid = await collect('openai', fakeExecutor([
      { type: 'done', summary: 'answer', inputTokens: NaN, outputTokens: -1, costUsd: Infinity }
    ]), dir)
    expect(invalid.at(-1)).toEqual({ type: 'done', result: { text: 'answer' } })
  })

  it('exposes the logical provider as id and backend "local_agent"', () => {
    const participant = toAgentCouncilParticipant('anthropic', fakeExecutor([]), dir)
    expect(participant.id).toBe('anthropic')
    expect(participant.backend).toBe('local_agent')
  })

  it('lists attached inputFiles as absolute paths in the prompt and does not copy them into the working directory', async () => {
    let capturedSpec: CodingTaskSpec | undefined
    const outside = join(dir, 'shot.png')
    writeFileSync(outside, 'png')
    const participant = toAgentCouncilParticipant('anthropic', fakeExecutor([{ type: 'done', summary: 'ok' }], (spec) => {
      capturedSpec = spec
    }), dir)
    for await (const _ of participant.generate({
      messages: [{ role: 'user', content: 'Beschreibe das Bild.' }],
      inputFiles: [{ filename: 'shot.png', mimeType: 'image/png', path: outside }]
    })) { /* drain */ }
    expect(capturedSpec?.prompt).toContain(outside)
    expect(capturedSpec?.prompt).toContain('nicht verändern')
    expect(capturedSpec?.workingDirectory).toBe(dir)
  })

  it('always forces permissionTier to read-only, regardless of anything else', async () => {
    let capturedSpec: CodingTaskSpec | undefined
    await collect('anthropic', fakeExecutor([{ type: 'done', summary: 'ok' }], (spec) => {
      capturedSpec = spec
    }), dir)
    expect(capturedSpec?.permissionTier).toBe('read-only')
  })

  it('REGRESSION (WebSearch/WebFetch denied in council mode): the read-only tool override includes both alongside Read/Glob/Grep', async () => {
    // Caught live in two rounds: the default read-only tier (Read/Glob/Grep
    // only) has no network tools, so a research-heavy council prompt first
    // got WebSearch denied, then WebFetch. Neither touches the filesystem,
    // so both belong in the council-mode allowlist without weakening the
    // actual invariant.
    let capturedSpec: CodingTaskSpec | undefined
    await collect('anthropic', fakeExecutor([{ type: 'done', summary: 'ok' }], (spec) => {
      capturedSpec = spec
    }), dir)
    expect(capturedSpec?.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])
    )
  })

  it('maps text and done events', async () => {
    const events = await collect(
      'anthropic',
      fakeExecutor([
        { type: 'text', text: 'thinking...' },
        { type: 'done', summary: 'final answer', sessionId: 's1' }
      ]),
      dir
    )
    expect(events).toEqual([
      { type: 'text_delta', text: 'thinking...' },
      { type: 'done', result: { text: 'final answer' } }
    ])
  })

  it('remaps file_change/command to warning and drops test_result', async () => {
    const events = await collect(
      'anthropic',
      fakeExecutor([
        { type: 'file_change', path: 'src/x.ts', changeType: 'modified' },
        { type: 'command', command: 'rm -rf x' },
        { type: 'test_result', passed: true, summary: 'irrelevant' },
        { type: 'done', summary: 'ok' }
      ]),
      dir
    )
    const types = events.map((e) => e.type)
    expect(types).toEqual(['warning', 'warning', 'done'])
    expect((events[0] as { message: string }).message).toContain('src/x.ts')
  })

  it('creates the working directory if it does not exist yet', async () => {
    const missing = join(dir, 'not-created-yet')
    expect(existsSync(missing)).toBe(false)
    await collect('anthropic', fakeExecutor([{ type: 'done', summary: 'ok' }]), missing)
    expect(existsSync(missing)).toBe(true)
  })

  it('does not emit policy_violation for a non-git working directory', async () => {
    const events = await collect('anthropic', fakeExecutor([{ type: 'done', summary: 'ok' }]), dir)
    expect(events.some((e) => e.type === 'policy_violation')).toBe(false)
  })

  it('emits policy_violation AFTER done when the repo changes during a supposedly read-only call', async () => {
    execFileSync('git', ['init'], { cwd: dir })
    const executor = fakeExecutor([
      // Simulate the agent slipping past the read-only tier and writing anyway.
      { type: 'status', message: 'working' },
      { type: 'done', summary: 'ok' }
    ])
    const originalStartTask = executor.startTask.bind(executor)
    executor.startTask = (spec, options) => {
      const handle = originalStartTask(spec, options)
      async function* wrapped(): AsyncGenerator<CodingExecutorEvent> {
        for await (const e of handle.events) {
          if (e.type === 'status') writeFileSync(join(dir, 'unexpected.txt'), 'oops')
          yield e
        }
      }
      return { taskId: handle.taskId, events: wrapped() }
    }

    const events = await collect('anthropic', executor, dir)
    const doneIndex = events.findIndex((e) => e.type === 'done')
    const violationIndex = events.findIndex((e) => e.type === 'policy_violation')
    expect(doneIndex).toBeGreaterThanOrEqual(0)
    expect(violationIndex).toBeGreaterThan(doneIndex)
  })

  it(
    'REGRESSION (Sicherheitsreview: sich selbst zurücknehmender Schreibvorgang blieb unsichtbar): ' +
      'a write that self-reverts within the retry window still proceeds, but is surfaced as a warning instead of vanishing silently',
    async () => {
      execFileSync('git', ['init'], { cwd: dir })
      const executor = fakeExecutor([{ type: 'status', message: 'working' }, { type: 'done', summary: 'ok' }])
      const originalStartTask = executor.startTask.bind(executor)
      executor.startTask = (spec, options) => {
        const handle = originalStartTask(spec, options)
        async function* wrapped(): AsyncGenerator<CodingExecutorEvent> {
          for await (const e of handle.events) {
            if (e.type === 'status') {
              // verifyWorkspaceUnchanged()'s first check (a real
              // snapshotWorkspace() call, spawning real git subprocesses)
              // alone can take a few hundred ms on Windows, and its retry
              // sleep is a fixed 500ms - this delay must land comfortably
              // after the first check has actually sampled the filesystem
              // but comfortably before the retry's own check.
              const marker = join(dir, 'unexpected.txt')
              writeFileSync(marker, 'a write that should not happen during a read-only turn')
              setTimeout(() => { try { rmSync(marker, { force: true }) } catch { /* ignore */ } }, 650)
            }
            yield e
          }
        }
        return { taskId: handle.taskId, events: wrapped() }
      }

      const events = await collect('anthropic', executor, dir)
      expect(events.some((e) => e.type === 'policy_violation')).toBe(false)
      const warning = events.find(
        (e) => e.type === 'warning' && (e as { message: string }).message.includes('Vorübergehende Arbeitsverzeichnis-Abweichung')
      )
      expect(warning).toBeDefined()
    }
  )

  it('REGRESSION (ein synchron werfender Teilnehmer stürzte den gesamten Rat ab): startTask() throwing synchronously yields an error event instead of crashing the caller', async () => {
    // Antigravity's own startTask() throws synchronously (before ever
    // returning a handle) when the prompt is too long for its argv-only
    // input path - caught live during a real taskgraph-generation run.
    // Left uncaught, that exception escaped this generator entirely and
    // crashed the whole multi-agent Council merge for every participant,
    // not just this one.
    const executor: CodingExecutor = {
      id: 'fake-executor',
      async detect() {
        return { installed: true, authStatus: 'authenticated' }
      },
      capabilities: () => ({ resumeSession: false, fileEditing: true, shellAccess: true }),
      startTask() {
        throw new Error('Der Prompt ist zu lang für fake-executor.')
      },
      streamEvents: () => undefined,
      getStatus: () => undefined,
      abort: () => {}
    }

    const events = await collect('anthropic', executor, dir)
    expect(events).toEqual([
      { type: 'error', error: { providerId: 'anthropic', code: 'unknown', message: 'Der Prompt ist zu lang für fake-executor.', retryable: false } }
    ])
  })

  it('still runs the policy check when the executor ends with error instead of done', async () => {
    execFileSync('git', ['init'], { cwd: dir })
    const executor = fakeExecutor([{ type: 'status', message: 'working' }, { type: 'error', message: 'boom' }])
    const originalStartTask = executor.startTask.bind(executor)
    executor.startTask = (spec, options) => {
      const handle = originalStartTask(spec, options)
      async function* wrapped(): AsyncGenerator<CodingExecutorEvent> {
        for await (const e of handle.events) {
          if (e.type === 'status') writeFileSync(join(dir, 'unexpected.txt'), 'oops')
          yield e
        }
      }
      return { taskId: handle.taskId, events: wrapped() }
    }

    const events = await collect('anthropic', executor, dir)
    const errorIndex = events.findIndex((e) => e.type === 'error')
    const violationIndex = events.findIndex((e) => e.type === 'policy_violation')
    expect(errorIndex).toBeGreaterThanOrEqual(0)
    expect(violationIndex).toBeGreaterThan(errorIndex)
  })
})
