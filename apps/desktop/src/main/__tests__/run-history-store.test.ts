import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryRunRecord } from '../ipc-types'

const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
import { appendRun, getRun } from '../run-history-store'

beforeEach(() => { state.dir = mkdtempSync(join(tmpdir(), 'council-history-')) })
afterEach(() => { rmSync(state.dir, { recursive: true, force: true }) })
const record = { id: 'run', kind: 'coding', prompt: 'test', logs: [] } as unknown as HistoryRunRecord

it('preserves corrupted history before saving a new record', () => {
  writeFileSync(join(state.dir, 'run-history.json'), '{broken')
  appendRun(record)
  expect(getRun('run')).toEqual(record)
  const backup = readdirSync(state.dir).find((name) => name.includes('.corrupted-'))!
  expect(readFileSync(join(state.dir, backup), 'utf-8')).toBe('{broken')
  expect(readdirSync(state.dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

it('refuses to overwrite a valid JSON value with an invalid history shape', () => {
  const path = join(state.dir, 'run-history.json')
  writeFileSync(path, '{"unexpected":true}')
  expect(() => appendRun(record)).toThrow(/Format/)
  expect(readFileSync(path, 'utf-8')).toBe('{"unexpected":true}')
})
