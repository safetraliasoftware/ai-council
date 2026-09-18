import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectVerificationProfileFromDirectory, detectVerificationProfileFromText } from '../workspace/detect-verification-profile'

describe('detectVerificationProfileFromDirectory', () => {
  const dirs: string[] = []
  const makeDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-council-stack-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined for an empty/unknown directory', () => {
    const dir = makeDir()
    expect(detectVerificationProfileFromDirectory(dir)).toBeUndefined()
  })

  it('returns undefined for a directory that does not exist', () => {
    expect(detectVerificationProfileFromDirectory(join(tmpdir(), 'ai-council-does-not-exist-xyz'))).toBeUndefined()
  })

  it('detects npm from package.json test+build scripts', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }))
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'npm', args: ['test'], timeoutMs: 300000 },
      { executable: 'npm', args: ['run', 'build'], timeoutMs: 300000 }
    ])
  })

  it('only includes scripts that actually exist in package.json', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([{ executable: 'npm', args: ['test'], timeoutMs: 300000 }])
  })

  it('falls through to other markers when package.json has no test/build script', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }))
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'go', args: ['test', './...'], timeoutMs: 300000 },
      { executable: 'go', args: ['build', './...'], timeoutMs: 300000 }
    ])
  })

  it('detects dotnet from a .csproj file', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'App.csproj'), '<Project />')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'dotnet', args: ['test'], timeoutMs: 300000 },
      { executable: 'dotnet', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects dotnet from a .sln file', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'App.sln'), '')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'dotnet', args: ['test'], timeoutMs: 300000 },
      { executable: 'dotnet', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects cargo from Cargo.toml', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"\n')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'cargo', args: ['test'], timeoutMs: 300000 },
      { executable: 'cargo', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects maven from pom.xml', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'pom.xml'), '<project />')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'mvn', args: ['test'], timeoutMs: 300000 },
      { executable: 'mvn', args: ['package'], timeoutMs: 300000 }
    ])
  })

  it('detects gradle from build.gradle, preferring the wrapper when present', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'build.gradle'), '')
    writeFileSync(join(dir, 'gradlew'), '')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: './gradlew', args: ['test'], timeoutMs: 300000 },
      { executable: './gradlew', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects gradle without a wrapper', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'build.gradle.kts'), '')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([
      { executable: 'gradle', args: ['test'], timeoutMs: 300000 },
      { executable: 'gradle', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects pytest from pyproject.toml', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="x"\n')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([{ executable: 'python', args: ['-m', 'pytest'], timeoutMs: 300000 }])
  })

  it('detects pytest from requirements.txt', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'requirements.txt'), 'flask\n')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([{ executable: 'python', args: ['-m', 'pytest'], timeoutMs: 300000 }])
  })

  it('prefers package.json over a coexisting go.mod (priority order)', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n')
    expect(detectVerificationProfileFromDirectory(dir)).toEqual([{ executable: 'npm', args: ['test'], timeoutMs: 300000 }])
  })
})

describe('detectVerificationProfileFromText', () => {
  it('returns undefined when no known stack keyword appears', () => {
    expect(detectVerificationProfileFromText('Ein Taschenrechner mit Grundrechenarten.')).toBeUndefined()
  })

  it('detects .NET from prose mentioning ".NET 8"', () => {
    expect(detectVerificationProfileFromText('Implementierung erfolgt in .NET 8 als Konsolenanwendung.')).toEqual([
      { executable: 'dotnet', args: ['test'], timeoutMs: 300000 },
      { executable: 'dotnet', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects Python', () => {
    expect(detectVerificationProfileFromText('Backend in Python mit FastAPI.')).toEqual([{ executable: 'python', args: ['-m', 'pytest'], timeoutMs: 300000 }])
  })

  it('detects Rust', () => {
    expect(detectVerificationProfileFromText('Ein CLI-Tool, geschrieben in Rust.')).toEqual([
      { executable: 'cargo', args: ['test'], timeoutMs: 300000 },
      { executable: 'cargo', args: ['build'], timeoutMs: 300000 }
    ])
  })

  it('detects Java/Spring', () => {
    expect(detectVerificationProfileFromText('Ein Spring-Boot-Service in Java.')).toEqual([
      { executable: 'mvn', args: ['test'], timeoutMs: 300000 },
      { executable: 'mvn', args: ['package'], timeoutMs: 300000 }
    ])
  })

  it('does not mistake JavaScript for Java', () => {
    expect(detectVerificationProfileFromText('Ein Frontend in JavaScript ohne Framework.')).toEqual([
      { executable: 'npm', args: ['test'], timeoutMs: 300000 },
      { executable: 'npm', args: ['run', 'build'], timeoutMs: 300000 }
    ])
  })

  it('detects Node/TypeScript/React', () => {
    expect(detectVerificationProfileFromText('Eine React-Anwendung mit TypeScript.')).toEqual([
      { executable: 'npm', args: ['test'], timeoutMs: 300000 },
      { executable: 'npm', args: ['run', 'build'], timeoutMs: 300000 }
    ])
  })
})
