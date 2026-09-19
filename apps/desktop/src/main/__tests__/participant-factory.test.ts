import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isGitRepo } from '@ai-council/coding'
import type { CodingExecutor, CodingExecutorEvent, ExecutorAvailability } from '@ai-council/coding'
import type { CodingExecutorId } from '../ipc-types'

const { mockUserDataDir } = vi.hoisted(() => ({ mockUserDataDir: { current: '' } }))

vi.mock('electron', () => ({
  app: { getPath: () => mockUserDataDir.current },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const { ElectronSecretStore } = await import('../secret-store')
const { ModelConfig } = await import('../model-config')
const { BackendConfig } = await import('../backend-config')
const { createParticipantFactory, clearDetectCache, clearScratchDirectoryCache } = await import(
  '../participant-factory'
)

function fakeExecutor(availability: ExecutorAvailability, events: CodingExecutorEvent[] = []): CodingExecutor {
  return {
    id: 'fake',
    detect: vi.fn(async () => availability),
    capabilities: () => ({ resumeSession: false, fileEditing: true, shellAccess: true }),
    startTask() {
      async function* gen(): AsyncGenerator<CodingExecutorEvent> {
        for (const e of events) yield e
      }
      return { taskId: 't1', events: gen() }
    },
    streamEvents: () => undefined,
    getStatus: () => undefined,
    abort: () => {}
  }
}

function allExecutors(overrides: Partial<Record<CodingExecutorId, CodingExecutor>> = {}): Record<CodingExecutorId, CodingExecutor> {
  return {
    'claude-code-cli': fakeExecutor({ installed: true, authStatus: 'authenticated' }),
    'openai-codex-cli': fakeExecutor({ installed: true, authStatus: 'unknown' }),
    'google-antigravity-cli': fakeExecutor({ installed: true, authStatus: 'unknown' }),
    'grok-build-cli': fakeExecutor({ installed: true, authStatus: 'unknown' }),
    ...overrides
  }
}

async function collect(participant: { generate: (req: { messages: { role: 'user'; content: string }[] }) => AsyncIterable<unknown> }) {
  const events = []
  for await (const e of participant.generate({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
  return events
}

describe('createParticipantFactory', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-participant-factory-'))
    mockUserDataDir.current = dir
    configPath = join(dir, 'config.json')
    clearDetectCache()
    clearScratchDirectoryCache()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves an "api" backend to an api participant regardless of key presence', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('anthropic', 'api')
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, allExecutors(), backendConfig)

    const participant = await buildParticipant('anthropic')
    expect(participant.backend).toBe('api')
    expect(participant.id).toBe('anthropic')
  })

  it('resolves a "local" backend to a local_agent participant', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('anthropic', 'local')
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, allExecutors(), backendConfig)

    const participant = await buildParticipant('anthropic')
    expect(participant.backend).toBe('local_agent')
  })

  it('"auto" prefers the local agent when installed, even with authStatus "unknown"', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('openai', 'auto')
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, allExecutors(), backendConfig)

    const participant = await buildParticipant('openai')
    expect(participant.backend).toBe('local_agent')
  })

  it('"auto" does not call the paid API when local is unavailable and fallback is disabled', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('gemini', 'auto')
    expect(backendConfig.getAllowPaidApiFallback()).toBe(false)
    const executors = allExecutors({ 'google-antigravity-cli': fakeExecutor({ installed: false, authStatus: 'unknown' }) })
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)

    const participant = await buildParticipant('gemini')
    expect(participant.backend).toBe('local_agent')
    const events = await collect(participant)
    // Matches provider-factory.ts's missingKeyProvider shape: start -> error, no done.
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['start', 'error'])
  })

  it('"auto" falls back to the paid API when local is unavailable and fallback is enabled', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('gemini', 'auto')
    backendConfig.setAllowPaidApiFallback(true)
    const executors = allExecutors({ 'google-antigravity-cli': fakeExecutor({ installed: false, authStatus: 'unknown' }) })
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)

    const participant = await buildParticipant('gemini')
    expect(participant.backend).toBe('api')
  })

  it('REGRESSION (Codex "not a trusted directory" failure): the scratch directory used for local-agent runs is a real git repo', async () => {
    // Caught live: Codex CLI refuses to run at all in a directory it
    // doesn't consider "trusted" unless it's a real git repo. The scratch
    // directory a local-agent participant runs in without a project
    // directory must therefore actually be one, not just an empty folder.
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('openai', 'local')
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, allExecutors(), backendConfig)

    await buildParticipant('openai')

    const scratchDir = join(dir, 'council-scratch')
    expect(await isGitRepo(scratchDir)).toBe(true)
  })

  it('REGRESSION (Workflow council ran against an empty scratch dir instead of the real project): an explicit workingDirectory is used instead of the scratch directory', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('anthropic', 'local')
    const executors = allExecutors()
    const startTask = vi.spyOn(executors['claude-code-cli'], 'startTask')
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)
    const projectDir = mkdtempSync(join(tmpdir(), 'ai-council-participant-factory-project-'))

    try {
      const participant = await buildParticipant('anthropic', projectDir)
      await collect(participant)

      expect(startTask).toHaveBeenCalledWith(
        expect.objectContaining({ workingDirectory: projectDir }),
        expect.anything()
      )
      const scratchDir = join(dir, 'council-scratch')
      expect(await isGitRepo(scratchDir)).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('falls back to the scratch directory when no workingDirectory is given (Compare/Team/Council)', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('anthropic', 'local')
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, allExecutors(), backendConfig)

    await buildParticipant('anthropic')

    const scratchDir = join(dir, 'council-scratch')
    expect(await isGitRepo(scratchDir)).toBe(true)
  })

  it('caches detect() results across multiple "auto" resolutions in the same session', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    backendConfig.setBackend('anthropic', 'auto')
    const executors = allExecutors()
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)

    await buildParticipant('anthropic')
    await buildParticipant('anthropic')
    expect(executors['claude-code-cli'].detect).toHaveBeenCalledTimes(1)
  })

  it('prepareAvailable includes Grok when ready and skips a missing seat instead of failing the whole council', async () => {
    const secretStore = ElectronSecretStore.loadFromDisk(configPath)
    const modelConfig = ModelConfig.loadFromDisk(configPath)
    const backendConfig = BackendConfig.loadFromDisk(configPath)
    for (const id of ['anthropic', 'openai', 'gemini', 'xai'] as const) backendConfig.setBackend(id, 'local')
    const executors = allExecutors({
      'google-antigravity-cli': fakeExecutor({ installed: false, authStatus: 'unknown' })
    })
    const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)
    const participants = await buildParticipant.prepareAvailable()
    const ids = participants.map((p) => p.id)
    expect(ids).toContain('anthropic')
    expect(ids).toContain('openai')
    expect(ids).toContain('xai')
    expect(ids).not.toContain('gemini')
  })
})
