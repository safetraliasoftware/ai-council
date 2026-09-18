import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
import { closeUsageStore, listUsage, recordCouncilUsage, saveUsage } from '../usage-store'

afterEach(() => { closeUsageStore(); if (state.dir) rmSync(state.dir, { recursive: true, force: true }) })

it('persists completed, failed and unknown measurements without inventing zero values', async () => {
  state.dir = mkdtempSync(join(tmpdir(), 'usage-store-'))
  const usage: any[] = []
  let listener: (() => void) | undefined
  const events = (async function* () {
    usage.push({ callId: 'call', providerId: 'openai', backend: 'api', inputChars: 4, outputChars: 2, durationMs: 1, outcome: 'completed', inputTokens: 10 })
    listener?.()
    yield { kind: 'run_done' as const, runId: 'run', usage }
  })()
  const run = { runId: 'run', usage, observeUsage(next: () => void) { listener = next }, events }
  for await (const _ of recordCouncilUsage(run, { kind: 'council', projectId: 'p' }).events) { /* drain */ }
  closeUsageStore()
  const saved = listUsage('p')[0]
  expect(saved.status).toBe('completed')
  expect(saved.calls[0]).toMatchObject({ inputTokens: 10, outcome: 'completed' })
  expect(saved.calls[0].outputTokens).toBeUndefined()
})

it('marks unfinished durable records as interrupted after restart', () => {
  state.dir = mkdtempSync(join(tmpdir(), 'usage-store-'))
  saveUsage({ runId: 'running', kind: 'coding', startedAt: 1, status: 'running', calls: [{ backend: 'local_agent', inputChars: 1, outputChars: 0, durationMs: 0, outcome: 'running' }] })
  closeUsageStore()
  expect(listUsage()[0]).toMatchObject({ status: 'interrupted', calls: [{ outcome: 'interrupted' }] })
})
