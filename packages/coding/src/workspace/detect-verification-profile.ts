import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DetectedCommand {
  executable: string
  args: string[]
  timeoutMs: number
}

const TIMEOUT_MS = 300_000

function cmd(executable: string, args: string[]): DetectedCommand {
  return { executable, args, timeoutMs: TIMEOUT_MS }
}

/**
 * Best-effort default for the Prüfprofil form - never auto-approved, the
 * human still reviews and confirms it. Deterministic and free (no council
 * call): scans the working directory for known project manifests so a
 * freshly generated task graph doesn't default to npm for every stack.
 */
export function detectVerificationProfileFromDirectory(dir: string): DetectedCommand[] | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const has = (name: string): boolean => entries.includes(name)
  const hasExt = (ext: string): boolean => entries.some((e) => e.toLowerCase().endsWith(ext))

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { scripts?: Record<string, unknown> }
      const scripts = pkg.scripts ?? {}
      const out: DetectedCommand[] = []
      if (scripts.test) out.push(cmd('npm', ['test']))
      if (scripts.build) out.push(cmd('npm', ['run', 'build']))
      if (out.length) return out
    } catch {
      // fall through to the other markers below
    }
  }
  if (hasExt('.sln') || hasExt('.csproj')) return [cmd('dotnet', ['test']), cmd('dotnet', ['build'])]
  if (has('go.mod')) return [cmd('go', ['test', './...']), cmd('go', ['build', './...'])]
  if (has('Cargo.toml')) return [cmd('cargo', ['test']), cmd('cargo', ['build'])]
  if (has('pom.xml')) return [cmd('mvn', ['test']), cmd('mvn', ['package'])]
  if (has('build.gradle') || has('build.gradle.kts')) {
    const gradle = has('gradlew') ? './gradlew' : has('gradlew.bat') ? 'gradlew.bat' : 'gradle'
    return [cmd(gradle, ['test']), cmd(gradle, ['build'])]
  }
  if (has('pyproject.toml') || has('requirements.txt')) return [cmd('python', ['-m', 'pytest'])]
  return undefined
}

/**
 * Fallback for greenfield projects with no manifest yet: scans the already
 * approved specification's free text (goal/architectureNotes/requirements)
 * for stack keywords. Same command sets as the directory detector above.
 */
export function detectVerificationProfileFromText(text: string): DetectedCommand[] | undefined {
  const t = text.toLowerCase()
  const word = (w: string): boolean => new RegExp(`\\b${w}\\b`, 'i').test(t)
  const has = (s: string): boolean => t.includes(s)

  if (has('.net') || word('dotnet') || has('c#') || has('asp.net')) return [cmd('dotnet', ['test']), cmd('dotnet', ['build'])]
  if (word('python') || word('django') || word('flask') || word('fastapi') || word('pytest')) return [cmd('python', ['-m', 'pytest'])]
  if (word('rust') || word('cargo')) return [cmd('cargo', ['test']), cmd('cargo', ['build'])]
  if (word('java') || word('spring') || word('maven') || word('gradle')) return [cmd('mvn', ['test']), cmd('mvn', ['package'])]
  if (word('node') || word('nodejs') || word('typescript') || word('react') || word('npm') || word('javascript')) {
    return [cmd('npm', ['test']), cmd('npm', ['run', 'build'])]
  }
  return undefined
}
