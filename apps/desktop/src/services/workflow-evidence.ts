import type { CommandResult, TaskAttempt, Verdict } from '@ai-council/project-domain'

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit / 2)}\n[Auszug: mittlerer Teil ausgelassen; vollständige Ausgabe im Prüfprotokoll]\n${text.slice(-limit / 2)}`
}

/** Keep actual outcomes, commands and diagnostics; avoid resending megabytes of build logs. */
export function checksForPrompt(checks: CommandResult[]) {
  return checks.map(check => ({ ...check,
    stdout: excerpt(check.stdout, 6000), stderr: excerpt(check.stderr, 6000)
  }))
}

export function correctionEvidence(checks: CommandResult[], reviews: Verdict[]): string {
  return JSON.stringify({
    checks: checksForPrompt(checks.filter(check => !check.success)),
    reviews: reviews.filter(review => review.verdict !== 'pass')
  })
}

/**
 * Bounded summary of why past attempts at the same task did NOT succeed, so
 * a fresh attempt doesn't blindly repeat the same mistake. Caught live: the
 * calculator project's TASK-001 needed 10 attempts, several of them failing
 * on the exact same reviewer objection with zero awareness of the prior
 * attempt's outcome.
 */
export function previousAttemptsSummary(attempts: TaskAttempt[]): string {
  const relevant = attempts.filter(a => a.status === 'failed' || a.status === 'discarded' || a.status === 'escalated').slice(-3)
  if (!relevant.length) return ''
  const entries = relevant.map((a, i) => ({
    versuch: i + 1, status: a.status,
    fehler: a.error ? excerpt(a.error, 300) : undefined,
    reviewBefunde: a.reviews.flatMap(r => r.findings).map(f => `[${f.severity}] ${f.message}`).slice(0, 5)
  }))
  return `Vorherige Versuche für diesen Task sind daran gescheitert - nicht denselben Fehler wiederholen:\n${JSON.stringify(entries)}`
}
