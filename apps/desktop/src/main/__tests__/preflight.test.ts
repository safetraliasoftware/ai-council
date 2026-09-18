import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executionPreflight, findExecutable, PreflightError } from '../preflight'
import type { CodingExecutor } from '@ai-council/coding'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
function executor(installed = true, authStatus: 'authenticated' | 'unauthenticated' = 'authenticated'): CodingExecutor {
  return { id: 'agent', detect: vi.fn(async () => ({ installed, authStatus })), capabilities: () => ({ resumeSession: false, fileEditing: true, shellAccess: true }),
    startTask: () => { throw new Error('must not start during preflight') }, streamEvents: () => undefined, getStatus: () => undefined, abort: vi.fn() }
}

it('resolves tools without executing them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preflight-')); dirs.push(dir)
  const command = process.platform === 'win32' ? 'safe-tool.cmd' : 'safe-tool'
  const path = join(dir, command)
  await writeFile(path, process.platform === 'win32' ? '@exit /b 99' : '#!/bin/sh\nexit 99')
  if (process.platform !== 'win32') await import('node:fs/promises').then(fs => fs.chmod(path, 0o755))
  expect((await findExecutable('safe-tool', dir, { PATH: dir, PATHEXT: '.CMD' }, process.platform))?.toLowerCase()).toBe(path.toLowerCase())
})

it('collects missing directory, tool, installation and login problems before any agent starts', async () => {
  const missing = join(tmpdir(), `missing-parent-${Date.now()}`, 'project')
  const absent = executor(false)
  const loggedOut = executor(true, 'unauthenticated')
  await expect(executionPreflight(missing, [{ executable: `missing-tool-${Date.now()}`, args: [], timeoutMs: 1000 }], [absent, loggedOut], false))
    .rejects.toMatchObject({ issues: expect.arrayContaining([
      expect.stringContaining('Projektordner'), expect.stringContaining('Werkzeug'), expect.stringContaining('nicht installiert'), expect.stringContaining('nicht angemeldet')
    ]) })
})
