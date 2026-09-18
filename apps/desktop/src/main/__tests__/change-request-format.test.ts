import { describe, expect, it } from 'vitest'
import type { ChangeRequest, ProjectSpecification } from '@ai-council/project-domain'
import type { ExecutionTask } from '@ai-council/task-graph'
import {
  buildChangeRequestReviewPrompt,
  buildReplacementTaskPrompt,
  parseChangeRequestVerdict,
  parseReplacementTasks
} from '../change-request-format'

function fixtureSpec(overrides: Partial<ProjectSpecification> = {}): ProjectSpecification {
  return {
    id: 'proj-1', version: 1, goal: 'Dienstplan-App bauen',
    requirements: [{ id: 'REQ-001', category: 'feature', statement: 'Schichten planen', acceptanceCriteria: [] }],
    nonGoals: [], architectureNotes: '', risks: [], openQuestions: [],
    chairId: 'anthropic', rawSynthesisText: '{}', status: 'human_approved', createdAt: 1000, updatedAt: 1000,
    ...overrides
  }
}

function fixtureCr(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'cr-1', projectId: 'proj-1', reason: 'Architektur-Problem', affectedRequirementIds: ['REQ-001'],
    affectedTaskIds: ['TASK-001'], proposedChanges: 'Anderer Ansatz', severity: 'architecture',
    status: 'pending', createdAt: 1000, ...overrides
  }
}

function fixtureTask(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id: 'TASK-001', specVersion: 1, requirementIds: ['REQ-001'], title: 'Datenmodell', description: 'Schicht-Entität',
    dependencies: [], scope: { allowedPaths: [] }, status: 'escalated', ...overrides
  }
}

describe('buildChangeRequestReviewPrompt', () => {
  it('includes the spec, affected tasks, escalation reason and human proposal', () => {
    const prompt = buildChangeRequestReviewPrompt(fixtureCr(), fixtureSpec(), [fixtureTask()])
    expect(prompt).toContain('Dienstplan-App bauen')
    expect(prompt).toContain('TASK-001')
    expect(prompt).toContain('Architektur-Problem')
    expect(prompt).toContain('Anderer Ansatz')
  })

  it('says explicitly when no human proposal exists yet, instead of an empty section', () => {
    const prompt = buildChangeRequestReviewPrompt(fixtureCr({ proposedChanges: '' }), fixtureSpec(), [fixtureTask()])
    expect(prompt).toMatch(/kein menschlicher Vorschlag/)
  })
})

describe('parseChangeRequestVerdict', () => {
  it('parses a clean JSON verdict', () => {
    const verdict = parseChangeRequestVerdict('{"recommendation":"proceed","rationale":"Macht Sinn."}')
    expect(verdict).toEqual({ recommendation: 'proceed', rationale: 'Macht Sinn.' })
  })

  it('tolerates a fenced JSON block anywhere in the response', () => {
    const verdict = parseChangeRequestVerdict('Ich habe das geprüft.\n```json\n{"recommendation":"reject","rationale":"Nicht nötig."}\n```')
    expect(verdict.recommendation).toBe('reject')
  })

  it('tolerates prose before a bare (unfenced) JSON object', () => {
    const verdict = parseChangeRequestVerdict('Ich prüfe die Änderung.\n{"recommendation":"proceed","rationale":"Ja."}')
    expect(verdict.recommendation).toBe('proceed')
  })

  it('throws a clear error quoting the reply when no JSON is found', () => {
    expect(() => parseChangeRequestVerdict('Ich melde mich später.')).toThrow(/Ich melde mich später/)
  })

  it('rejects a recommendation value outside proceed|reject', () => {
    expect(() => parseChangeRequestVerdict('{"recommendation":"maybe","rationale":"x"}')).toThrow()
  })

  it('rejects a missing rationale', () => {
    expect(() => parseChangeRequestVerdict('{"recommendation":"proceed","rationale":""}')).toThrow()
  })
})

describe('buildReplacementTaskPrompt', () => {
  it('includes the invalidated tasks, the new spec version, and the change reason', () => {
    const prompt = buildReplacementTaskPrompt([fixtureTask({ status: 'invalidated' })], fixtureSpec({ version: 2 }), fixtureCr())
    expect(prompt).toContain('TASK-001')
    expect(prompt).toContain('Version 2')
    expect(prompt).toContain('Architektur-Problem')
  })
})

describe('parseReplacementTasks', () => {
  const VALID = [
    { replacesTaskId: 'TASK-001', id: 'TASK-002', requirementIds: ['REQ-001'], title: 'Ersatz', description: '', dependencies: [], scope: { allowedPaths: [] } }
  ]

  it('extracts and validates a fenced JSON array', () => {
    const raw = '```json\n' + JSON.stringify(VALID) + '\n```'
    const result = parseReplacementTasks(raw, ['TASK-001'])
    expect(result).toHaveLength(1)
    expect(result[0].replacesTaskId).toBe('TASK-001')
  })

  it('tolerates prose before the JSON array', () => {
    const raw = 'Hier sind die Ersatz-Tasks:\n' + JSON.stringify(VALID)
    const result = parseReplacementTasks(raw, ['TASK-001'])
    expect(result[0].id).toBe('TASK-002')
  })

  it('rejects a replacesTaskId that was not in the requested set', () => {
    const raw = JSON.stringify(VALID)
    expect(() => parseReplacementTasks(raw, ['TASK-999'])).toThrow(/replacesTaskId/)
  })

  it('rejects an invalid dependency shape', () => {
    const raw = JSON.stringify([{ ...VALID[0], dependencies: [{ taskId: 'X' }] }])
    expect(() => parseReplacementTasks(raw, ['TASK-001'])).toThrow(/Abhängigkeit/)
  })

  it('throws a clear error when no JSON array is found', () => {
    expect(() => parseReplacementTasks('Tut mir leid, das kann ich nicht liefern.', ['TASK-001'])).toThrow()
  })

  it('throws on an empty array', () => {
    expect(() => parseReplacementTasks('[]', ['TASK-001'])).toThrow()
  })
})
