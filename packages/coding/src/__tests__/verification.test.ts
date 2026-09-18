import { describe, expect, it } from 'vitest'
import { runVerification, parseReviewVerdict } from '../verification'

describe('VerificationRunner', { timeout: 15000 }, () => {
  it('keeps optional suggestions separate without hiding blocking defects', () => {
    expect(parseReviewVerdict(JSON.stringify({ verdict: 'pass', findings: [], suggestions: [{ severity: 'low', message: 'Optional name change' }] })).verdict).toBe('pass')
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'pass', findings: [], suggestions: [{ severity: 'high', message: 'Security defect' }] }))).toThrow()
    expect(() => parseReviewVerdict(JSON.stringify({ verdict: 'pass', findings: [{ severity: 'high', message: 'broken' }] }))).toThrow()
  })
  it('routes repairable contract defects to correction while preserving real and legacy escalations', () => {
    const review = { verdict: 'escalate', findings: [{ severity: 'high', message: 'Copy mutable lists and test overflow.' }] }
    expect(parseReviewVerdict(JSON.stringify({ ...review, resolution: 'implementation' })).verdict).toBe('fail')
    expect(parseReviewVerdict(JSON.stringify({ ...review, resolution: 'user_decision' })).verdict).toBe('escalate')
    expect(parseReviewVerdict(JSON.stringify(review)).verdict).toBe('escalate')
    expect(() => parseReviewVerdict(JSON.stringify({ ...review, resolution: 'whatever' }))).toThrow()
  })
  it('reports actual stdout, stderr and exit status', async () => {
    const result = await runVerification({ executable: process.execPath, args: ['-e', "console.log('test output');console.error('failure');process.exit(7)"], timeoutMs: 5000 }, process.cwd())
    expect(result).toMatchObject({ success: false, exitCode: 7, timedOut: false, aborted: false })
    expect(result.stdout).toContain('test output'); expect(result.stderr).toContain('failure')
  })
  it('times out a hanging process', async () => {
    const result = await runVerification({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 500 }, process.cwd())
    expect(result).toMatchObject({ success: false, timedOut: true })
  })
  it('does not start an already-aborted command', async () => {
    const controller = new AbortController(); controller.abort()
    const result = await runVerification({ executable: 'never-run-me', args: [], timeoutMs: 5000 }, process.cwd(), controller.signal)
    expect(result).toMatchObject({ success: false, aborted: true, stdout: '' })
  })
  it('rejects prose and contradictory passing verdicts', () => {
    expect(() => parseReviewVerdict('all good')).toThrow()
    expect(() => parseReviewVerdict('{"verdict":"pass","findings":[{"severity":"high","message":"broken"}]}')).toThrow()
    expect(parseReviewVerdict('{"verdict":"pass","findings":[]}').verdict).toBe('pass')
  })
  it('REGRESSION (prose lead-in before the JSON verdict): tolerates plain-language text before a fenced or bare JSON object', () => {
    // Caught live: a reviewer prefixed its verdict with "Ich prüfe die
    // Dateien..." before the actual JSON - the old start/end-anchored fence
    // strip didn't account for that, so JSON.parse choked on the prose
    // itself with a cryptic native SyntaxError.
    const withFence = 'Ich prüfe die Dateien und den Diff.\n\n```json\n{"verdict":"pass","findings":[]}\n```'
    expect(parseReviewVerdict(withFence).verdict).toBe('pass')
    const withoutFence = 'Ich prüfe die Dateien.\n{"verdict":"fail","findings":[{"severity":"high","message":"x"}]}'
    expect(parseReviewVerdict(withoutFence).verdict).toBe('fail')
  })
  it('REGRESSION (unusable error message): a genuinely non-JSON response throws an error that quotes the actual reply instead of a raw native parser message', () => {
    expect(() => parseReviewVerdict('Ich prüfe die Dateien und melde mich gleich zurück.')).toThrow(/Ich prüfe die Dateien/)
  })
})
