import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: vi.fn(), renameSync: vi.fn()
}))
import { readFileSync, renameSync } from 'node:fs'
import { readJsonFileSafe } from '../json-file-store'
vi.mock('electron', () => ({ app: { getPath: () => 'test-data' } }))
import { readProjectEvents } from '../project-event-log'

afterEach(() => vi.resetAllMocks())

describe('JSON storage failures', () => {
  it.each(['EACCES', 'EIO'])('propagates event-log read failure %s instead of returning an empty history', code => {
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error('history unreadable'), { code }) })
    expect(() => readProjectEvents('p')).toThrow('history unreadable')
  })
  it('treats only a missing event log as an empty project', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) })
    expect(readProjectEvents('p')).toEqual([])
  })
  it('does not swallow an invalid project identifier when reading history', () => {
    expect(() => readProjectEvents('../escape')).toThrow()
    expect(readFileSync).not.toHaveBeenCalled()
  })
  it('propagates read errors instead of returning empty data', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    expect(() => readJsonFileSafe('data.json', [])).toThrow('denied')
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('aborts when the corrupted original cannot be backed up', () => {
    vi.mocked(readFileSync).mockReturnValue('{broken')
    vi.mocked(renameSync).mockImplementation(() => { throw new Error('backup failed') })
    expect(() => readJsonFileSafe('data.json', [])).toThrow('backup failed')
  })
})
