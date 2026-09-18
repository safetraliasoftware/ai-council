import { describe, expect, it } from 'vitest'
import type { TaskAttempt } from '@ai-council/project-domain'
import { previousAttemptsSummary } from '../workflow-evidence'

function attempt(overrides: Partial<TaskAttempt>): TaskAttempt {
  return { id: 'a', taskId: 'T1', specVersion: 1, startedAt: 0, status: 'failed',
    implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: [], ...overrides }
}

describe('previousAttemptsSummary', () => {
  it('returns an empty string when there are no relevant previous attempts', () => {
    expect(previousAttemptsSummary([])).toBe('')
    expect(previousAttemptsSummary([attempt({ status: 'accepted' })])).toBe('')
    expect(previousAttemptsSummary([attempt({ status: 'interrupted' })])).toBe('')
    expect(previousAttemptsSummary([attempt({ status: 'paused' })])).toBe('')
  })

  it('includes failed, discarded and escalated attempts, with their error and review findings', () => {
    const summary = previousAttemptsSummary([
      attempt({ id: 'a1', status: 'failed', error: 'Prüfungen fehlgeschlagen.', reviews: [{ verdict: 'fail', findings: [{ severity: 'medium', message: 'Fehlt X.' }] }] }),
      attempt({ id: 'a2', status: 'discarded' }),
      attempt({ id: 'a3', status: 'escalated', error: 'Architektur-Eskalation.' })
    ])
    expect(summary).toContain('Vorherige Versuche')
    expect(summary).toContain('Prüfungen fehlgeschlagen.')
    expect(summary).toContain('Fehlt X.')
    expect(summary).toContain('discarded')
    expect(summary).toContain('escalated')
  })

  it('caps at the last 3 relevant attempts, dropping older ones', () => {
    const attempts = [1, 2, 3, 4, 5].map(n => attempt({ id: `a${n}`, error: `Fehler ${n}` }))
    const summary = previousAttemptsSummary(attempts)
    expect(summary).not.toContain('Fehler 1')
    expect(summary).not.toContain('Fehler 2')
    expect(summary).toContain('Fehler 3')
    expect(summary).toContain('Fehler 4')
    expect(summary).toContain('Fehler 5')
  })

  it('truncates a long error message instead of resending it in full', () => {
    const summary = previousAttemptsSummary([attempt({ error: 'X'.repeat(5000) })])
    expect(summary.length).toBeLessThan(5000)
    expect(summary).toContain('Auszug')
  })

  it('caps review findings at 5 per attempt', () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({ severity: 'low' as const, message: `Fund ${i}` }))
    const summary = previousAttemptsSummary([attempt({ reviews: [{ verdict: 'fail', findings }] })])
    expect(summary).toContain('Fund 4')
    expect(summary).not.toContain('Fund 5')
  })
})
