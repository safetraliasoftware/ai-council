import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fingerprintWorkspace } from '../verification'

function gitSync(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`)
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'council-fingerprint-'))
  gitSync(['init'], dir)
  gitSync(['-c', 'user.email=x@x.com', '-c', 'user.name=x', 'commit', '--allow-empty', '-m', 'init'], dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('fingerprintWorkspace', () => {
  it('changes when a real source file is added, with no .gitignore present', async () => {
    const before = await fingerprintWorkspace(dir)
    await writeFile(join(dir, 'app.js'), 'console.log(1)')
    expect(await fingerprintWorkspace(dir)).not.toBe(before)
  })

  it(
    'REGRESSION (false "Arbeitsverzeichnis verändert" policy violation): ' +
      'ignores non-reproducible build output (bin/obj) even without a .gitignore',
    async () => {
      const before = await fingerprintWorkspace(dir)
      await mkdir(join(dir, 'src/Calculator.Core/bin/Debug'), { recursive: true })
      await mkdir(join(dir, 'src/Calculator.Core/obj'), { recursive: true })
      await writeFile(join(dir, 'src/Calculator.Core/bin/Debug/Calculator.Core.dll'), 'binary-content-v1')
      await writeFile(join(dir, 'src/Calculator.Core/obj/Calculator.Core.AssemblyInfo.cs'), 'v1')
      const afterFirstBuild = await fingerprintWorkspace(dir)
      expect(afterFirstBuild).toBe(before)

      // Simulate a lingering MSBuild/Roslyn build-server rewriting the same
      // generated files with different bytes (non-deterministic PDB/timestamp)
      // slightly after the triggering command already returned.
      await writeFile(join(dir, 'src/Calculator.Core/bin/Debug/Calculator.Core.dll'), 'binary-content-v2-different-guid')
      await writeFile(join(dir, 'src/Calculator.Core/obj/Calculator.Core.AssemblyInfo.cs'), 'v2')
      expect(await fingerprintWorkspace(dir)).toBe(before)
    }
  )

  it('still detects a change to a real file inside an otherwise-excluded-looking path if it is tracked', async () => {
    await mkdir(join(dir, 'build'), { recursive: true })
    await writeFile(join(dir, 'build', 'release-notes.md'), 'v1')
    gitSync(['add', 'build/release-notes.md'], dir)
    gitSync(['-c', 'user.email=x@x.com', '-c', 'user.name=x', 'commit', '-m', 'track release notes'], dir)
    const before = await fingerprintWorkspace(dir)
    await writeFile(join(dir, 'build', 'release-notes.md'), 'v2')
    expect(await fingerprintWorkspace(dir)).not.toBe(before)
  })
})
