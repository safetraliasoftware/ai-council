import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnProcess } from './process/spawn-process'

export interface VerificationCommand { executable: string; args: string[]; timeoutMs: number }
export interface VerificationResult {
  command: VerificationCommand; exitCode: number | null; stdout: string; stderr: string
  durationMs: number; success: boolean; timedOut: boolean; aborted: boolean; killConfirmed: boolean
  outputTruncated?: boolean
  /** Set when the spawn itself failed with ENOENT - the executable isn't installed/on PATH, not a real test/build failure. */
  missingExecutable?: boolean
}
export async function runVerification(command: VerificationCommand, cwd: string, signal?: AbortSignal): Promise<VerificationResult> {
  if (!command.executable?.trim() || !Array.isArray(command.args) || command.args.some(a => typeof a !== 'string') ||
      !Number.isFinite(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 3600000) {
    throw new Error('Ungültiger Prüf-Befehl oder Timeout (100–3600000 ms).')
  }
  const start = Date.now()
  const controller = new AbortController()
  let timedOut = false
  let stdout = '', stderr = ''
  let outputTruncated = false
  let missingExecutable = false
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, command.timeoutMs)
  try {
    if (controller.signal.aborted) return { command, exitCode: null, stdout, stderr, durationMs: 0, success: false, timedOut: false, aborted: true, killConfirmed: true }
    const handle = spawnProcess(command.executable, command.args, { cwd, signal: controller.signal })
    const limit = 2_000_000
    handle.child.stdout.setEncoding('utf8')
    handle.child.stderr.setEncoding('utf8')
    handle.child.stdout.on('data', (chunk: string) => { if (stdout.length + chunk.length > limit) outputTruncated = true; stdout = (stdout + chunk).slice(-limit) })
    handle.child.stderr.on('data', (chunk: string) => { if (stderr.length + chunk.length > limit) outputTruncated = true; stderr = (stderr + chunk).slice(-limit) })
    handle.child.on('error', err => { stderr += err.message; if ((err as NodeJS.ErrnoException).code === 'ENOENT') missingExecutable = true })
    const exitCode = await handle.exitCode
    return { command, exitCode, stdout, stderr, durationMs: Date.now() - start,
      success: exitCode === 0 && !controller.signal.aborted, timedOut,
      aborted: !!signal?.aborted, killConfirmed: handle.killConfirmed(), outputTruncated,
      missingExecutable: missingExecutable || undefined }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runVerification({ executable: 'git', args, timeoutMs: 60000 }, cwd)
  if (!result.success) throw new Error(result.stderr || `Git fehlgeschlagen: ${args.join(' ')}`)
  if (result.outputTruncated) throw new Error('Git-Ausgabe zu groß für eine vollständige Prüfung. Vorgang sicherheitshalber abgebrochen.')
  return result.stdout
}

/**
 * Untracked generated-output directories excluded from the fingerprint on top
 * of .gitignore - `--exclude` only affects git ls-files' `--others` (untracked)
 * listing, never `--cached`, so a file someone deliberately tracked under one
 * of these names still counts. Caught live: a .NET project with no .gitignore
 * failed a read-only reviewer turn with a false "workspace changed" policy
 * violation, because `dotnet build`/`dotnet test` output (bin/obj) is not
 * byte-reproducible (PDB GUIDs, embedded timestamps) and a lingering MSBuild/
 * Roslyn build-server process kept writing to obj/*.cache slightly after the
 * command that triggered it had already returned - landing inside the
 * read-only window and getting fingerprinted as real content change.
 */
const GENERATED_OUTPUT_EXCLUDES = [
  'bin/', 'obj/', 'TestResults/', 'node_modules/', 'dist/', 'build/', '.next/', '.nuxt/',
  'coverage/', '__pycache__/', '.venv/', 'venv/', '.pytest_cache/', 'target/', '.gradle/', '.cache/',
  // Staged Compare/Council attachments. Copied in so local CLIs can read a
  // PDF that lives in Downloads; must not fingerprint as a workspace write
  // when several seats copy in parallel.
  '.ai-council-attachments/'
]

/**
 * Per-path summary (mode, size, short content hash - never the raw bytes, so
 * this stays safe to put directly into a thrown error message) alongside the
 * overall digest. The digest's hash.update() sequence is intentionally
 * byte-identical to the previous fingerprintWorkspace() implementation, so
 * fingerprintWorkspace() below keeps returning the exact same value as
 * before for any given workspace state - `attempt.fingerprint` values
 * already persisted from before this change stay comparable.
 */
export interface WorkspaceSnapshot { digest: string; entries: Map<string, string> }

export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const paths = (await gitOutput(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
    ...GENERATED_OUTPUT_EXCLUDES.map(pattern => `--exclude=${pattern}`)])).split('\0').filter(Boolean)
  const hash = createHash('sha256')
  const head = await runVerification({ executable: 'git', args: ['rev-parse', '--verify', 'HEAD'], timeoutMs: 60000 }, cwd)
  hash.update(head.success ? head.stdout : 'unborn')
  const entries = new Map<string, string>([['HEAD', head.success ? head.stdout : 'unborn']])
  for (const path of [...new Set(paths)].sort()) {
    hash.update(JSON.stringify(path))
    let entry: string
    try {
      const stat = await lstat(join(cwd, path))
      hash.update(String(stat.mode))
      if (stat.isSymbolicLink()) {
        const target = await readlink(join(cwd, path))
        hash.update(target)
        entry = `symlink(mode=${stat.mode}) -> ${target}`
      } else if (stat.isFile()) {
        const content = await readFile(join(cwd, path))
        hash.update(content)
        entry = `file(mode=${stat.mode}, ${content.length}b, ${createHash('sha256').update(content).digest('hex').slice(0, 12)})`
      } else {
        throw new Error(`Nicht unterstützter Repository-Eintrag: ${path}`)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      hash.update('deleted')
      entry = 'deleted'
    }
    hash.update('\0')
    entries.set(path, entry)
  }
  return { digest: hash.digest('hex'), entries }
}

/** Hash the exact non-ignored workspace, including dirty and untracked file contents. */
export async function fingerprintWorkspace(cwd: string): Promise<string> {
  return (await snapshotWorkspace(cwd)).digest
}

export interface ReviewFinding { severity: 'critical' | 'high' | 'medium' | 'low'; message: string; file?: string; requirementId?: string }
export interface ReviewVerdict { verdict: 'pass' | 'fail' | 'escalate'; findings: ReviewFinding[]; suggestions?: ReviewFinding[]; reason?: string; resolution?: 'implementation' | 'user_decision' }
export const REVIEW_CONTRACT = `
Antworte abschließend ausschließlich als JSON: {"verdict":"pass|fail|escalate","resolution":"implementation|user_decision","findings":[{"severity":"critical|high|medium|low","message":"konkreter Befund und erforderliche Korrektur","file":"optional","requirementId":"optional"}],"reason":"Begründung"}.
pass nur ohne offene Findings. Optionale Stil-, Benennungs- und Komfortvorschläge gehören ausschließlich ins zusätzliche Array "suggestions" (gleiche Struktur, severity="low") und verhindern pass nicht. findings enthält nur konkrete Funktionsfehler, Sicherheitsfehler oder Verletzungen verbindlicher Anforderungen, jeweils mit Auslöser und beobachtbarer Auswirkung. Keine erfundenen Testergebnisse; ein Testlauf ohne Tests ist kein Verhaltensnachweis.
Nach einer Korrektur prüfe jeden bisherigen Befund ausdrücklich gegen den neuen Code und markiere Erledigtes nicht erneut als offen. Neue Blocker nur mit neuer konkreter Evidenz; keine nachträglichen Wunschfunktionen. Liefere alle erkennbaren notwendigen Korrekturen gesammelt.
fail mit resolution=implementation für lokal behebbare Fehler innerhalb der genehmigten Anforderungen und erlaubten Pfade, auch bei hoher Schwere oder betroffenen Schnittstellen. Defensive Kopien, fehlende Fehlerfälle/Erklärungsschlüssel, Überlaufprüfungen und zugehörige Tests gehören in die automatische Korrekturrunde. Allein das Wort Architektur, ein neuer interner Fehlertyp oder eine dokumentierte Standardannahme ist kein Eskalationsgrund.
escalate mit resolution=user_decision nur wenn eine konkrete Nutzerentscheidung nötig ist: widersprüchliche verbindliche Anforderungen, wesentliche Änderung des Produkts, nicht genehmigte Kosten/externe Auswirkungen oder eine notwendige Erweiterung des erlaubten Bereichs. Benenne in reason die betroffene Vorgabe, warum eine lokale Korrektur nicht genügt, die konkrete Frage und eine Empfehlung. Keine Freigabe trotz tatsächlicher Fehler; keine zusätzlichen Anforderungen erfinden.`
/**
 * Finds the JSON object REVIEW_CONTRACT asks for, tolerating surrounding
 * prose - a fenced ```json block anywhere in the text (not just exactly at
 * the start/end), or otherwise the outermost {...} span. Caught live: a
 * reviewer prefixed its verdict with a plain-language lead-in ("Ich prüfe
 * die Dateien...") before the actual JSON, which the old start/end-anchored
 * fence strip didn't account for - JSON.parse then failed on the prose
 * itself with a cryptic native SyntaxError instead of a usable message.
 */
function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return undefined
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const trimmed = text.trim()
  const excerpt = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
  const block = extractJsonObject(trimmed)
  if (!block) {
    throw new Error(`Review-Antwort enthält kein erkennbares JSON-Urteil. Antwort begann mit: "${excerpt}"`)
  }
  let result: ReviewVerdict
  try {
    result = JSON.parse(block) as ReviewVerdict
  } catch (err) {
    throw new Error(
      `Review-JSON konnte nicht geparst werden: ${err instanceof Error ? err.message : String(err)}. Antwort begann mit: "${excerpt}"`
    )
  }
  if (!result || !['pass', 'fail', 'escalate'].includes(result.verdict) || !Array.isArray(result.findings) ||
      result.findings.some(f => !f || !['critical','high','medium','low'].includes(f.severity) || typeof f.message !== 'string') ||
      (result.verdict === 'pass' && result.findings.length > 0)) throw new Error('Review enthält kein gültiges, widerspruchsfreies Urteil.')
  if (result.resolution !== undefined && !['implementation', 'user_decision'].includes(result.resolution)) {
    throw new Error('Review enthält eine ungültige Zuständigkeit für die Korrektur.')
  }
  if (result.suggestions !== undefined && (!Array.isArray(result.suggestions) || result.suggestions.some(f => !f || f.severity !== 'low' || typeof f.message !== 'string'))) {
    throw new Error('Optionale Review-Hinweise müssen niedrig priorisiert und konkret beschrieben sein.')
  }
  // A repairable finding must enter the bounded fix/review cycle, even if
  // the reviewer calls an internal contract bug an "architecture" issue.
  // Legacy escalations without classification remain escalations.
  if (result.verdict === 'escalate' && result.resolution === 'implementation') return { ...result, verdict: 'fail' }
  return result
}
