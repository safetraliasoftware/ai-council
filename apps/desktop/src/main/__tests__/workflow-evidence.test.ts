import { expect, it } from 'vitest'
import type { CommandResult } from '@ai-council/project-domain'
import { checksForPrompt, correctionEvidence } from '../../services/workflow-evidence'

it('bounds repeated logs without hiding their outcomes or changing the saved evidence', () => {
  const check: CommandResult = { command: { executable: 'test', args: [], timeoutMs: 1000 }, exitCode: 1,
    stdout: 'start' + 'x'.repeat(30000) + 'failure at end', stderr: '', durationMs: 5,
    success: false, timedOut: false, aborted: false, killConfirmed: true }
  const [result] = checksForPrompt([check])
  expect(result.stdout.length).toBeLessThan(6200)
  expect(result.stdout).toContain('start')
  expect(result.stdout).toContain('failure at end')
  expect(result.stdout).toContain('ausgelassen')
  expect(result.success).toBe(false)
  expect(check.stdout.length).toBeGreaterThan(30000)
  const correction = JSON.parse(correctionEvidence([{ ...check, success: true }, check], [
    { verdict: 'pass', findings: [], reason: 'already accepted' },
    { verdict: 'fail', findings: [{ severity: 'high', message: 'fix overflow' }] }
  ]))
  expect(correction.checks).toHaveLength(1)
  expect(correction.reviews).toHaveLength(1)
  expect(correction.reviews[0].findings[0].message).toBe('fix overflow')
})
