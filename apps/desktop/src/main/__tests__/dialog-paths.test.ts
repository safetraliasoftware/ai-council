import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstExistingDir, parentDir } from '../dialog-paths'

describe('dialog-paths', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('returns the first candidate that exists on disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-dialog-'))
    const nested = join(dir, 'nested')
    mkdirSync(nested)
    expect(firstExistingDir(join(dir, 'missing'), nested, dir)).toBe(nested)
    expect(firstExistingDir(undefined, join(dir, 'nope'))).toBeUndefined()
  })

  it('returns the parent directory of a file path', () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-dialog-'))
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'x')
    expect(parentDir(file)).toBe(dir)
    expect(parentDir(undefined)).toBeUndefined()
  })
})
