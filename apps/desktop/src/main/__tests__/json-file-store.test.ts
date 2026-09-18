import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertSafeId, readJsonFileSafe, writeJsonFileAtomic } from '../json-file-store'

describe('readJsonFileSafe / writeJsonFileAtomic', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-json-store-'))
    filePath = join(dir, 'nested', 'data.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the fallback when the file does not exist yet', () => {
    expect(readJsonFileSafe(filePath, { hello: 'world' })).toEqual({ hello: 'world' })
  })

  it('round-trips data through write and read, creating missing directories', () => {
    writeJsonFileAtomic(filePath, { a: 1 })
    expect(readJsonFileSafe(filePath, {})).toEqual({ a: 1 })
  })

  it('REGRESSION (corruption vs. emptiness): a corrupted file is renamed aside, not silently treated as empty-then-overwritten', () => {
    const nestedDir = join(dir, 'nested')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(filePath, '{ this is not valid json', 'utf-8')

    const result = readJsonFileSafe(filePath, { fallback: true })
    expect(result).toEqual({ fallback: true })

    // The original corrupted content must still exist somewhere on disk
    // under a ".corrupted-*" name, not have been silently discarded.
    expect(existsSync(filePath)).toBe(false)
    const corruptedFiles = readdirSync(nestedDir).filter((n) => n.includes('.corrupted-'))
    expect(corruptedFiles.length).toBe(1)
  })

  it('does not leave a temp file behind after a successful write', () => {
    writeJsonFileAtomic(filePath, { a: 1 })
    const files = readdirSync(join(dir, 'nested'))
    expect(files).toEqual(['data.json'])
  })
})

describe('assertSafeId', () => {
  it('accepts typical ids (uuid-like, alphanumeric with - and _)', () => {
    expect(() => assertSafeId('a1b2c3-d4e5_f6')).not.toThrow()
  })

  it('rejects path traversal attempts', () => {
    expect(() => assertSafeId('../../etc/passwd')).toThrow()
  })

  it('rejects path separators', () => {
    expect(() => assertSafeId('foo/bar')).toThrow()
    expect(() => assertSafeId('foo\\bar')).toThrow()
  })

  it('includes the given label in the error message', () => {
    expect(() => assertSafeId('bad id', 'Projekt-ID')).toThrow(/Projekt-ID/)
  })
})
