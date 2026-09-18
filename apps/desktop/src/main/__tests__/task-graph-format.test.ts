import { describe, expect, it } from 'vitest'
import type { ProjectSpecification } from '@ai-council/project-domain'
import { buildTaskGraphPrompt, isTaskGraphParseError, parseTaskGraphJson } from '../task-graph-format'

function fixtureSpec(overrides: Partial<ProjectSpecification> = {}): ProjectSpecification {
  return {
    id: 'proj-1',
    version: 1,
    goal: 'Dienstplan-App bauen',
    requirements: [
      { id: 'REQ-001', category: 'feature', statement: 'Schichten planen', acceptanceCriteria: ['Nutzer kann eine Schicht anlegen'] }
    ],
    nonGoals: ['Keine native iOS-App'],
    architectureNotes: 'Kotlin, lokale Datenbank',
    risks: ['Zeitzonen-Handling'],
    openQuestions: [],
    chairId: 'anthropic',
    rawSynthesisText: '{}',
    status: 'human_approved',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

describe('buildTaskGraphPrompt', () => {
  it('includes the goal, requirement ids, and a JSON schema instruction', () => {
    const prompt = buildTaskGraphPrompt(fixtureSpec())
    expect(prompt).toContain('Dienstplan-App bauen')
    expect(prompt).toContain('REQ-001')
    expect(prompt).toContain('Nutzer kann eine Schicht anlegen')
    expect(prompt).toContain('```json')
    expect(prompt).toContain('dependencies')
  })

  it('REGRESSION (read-only-mode confusion): clarifies that its own read-only execution is not a property of the target project', () => {
    const prompt = buildTaskGraphPrompt(fixtureSpec())
    expect(prompt).toMatch(/schreibgeschützten Beratungsmodus/)
  })

  it('REGRESSION (soft-dependency readiness confusion): clarifies that soft dependencies still block a task from starting', () => {
    // Caught live: a council participant assigned "soft" impact to
    // dependencies it clearly intended as non-blocking for readiness (e.g.
    // "production readiness doesn't need payroll export done first") - but
    // the TaskGraph engine's canRun() requires ALL dependencies accepted
    // regardless of hard/soft; soft only affects invalidation later.
    const prompt = buildTaskGraphPrompt(fixtureSpec())
    expect(prompt).toMatch(/muss abgeschlossen sein, bevor der Task beginnen kann/)
  })
})

const VALID_TASKS = [
  {
    id: 'TASK-001',
    requirementIds: ['REQ-001'],
    title: 'Datenmodell anlegen',
    description: 'Schicht-Entität definieren',
    dependencies: [],
    scope: { allowedPaths: ['src/domain/**'] }
  },
  {
    id: 'TASK-002',
    requirementIds: ['REQ-001'],
    title: 'UI für Schichtplanung',
    description: 'Formular zum Anlegen einer Schicht',
    dependencies: [{ taskId: 'TASK-001', impact: 'hard' }],
    scope: { allowedPaths: ['src/ui/**'] }
  }
]

describe('parseTaskGraphJson', () => {
  it('extracts and parses a clean ```json array', () => {
    const raw = '```json\n' + JSON.stringify(VALID_TASKS) + '\n```'
    const result = parseTaskGraphJson(raw)
    expect(isTaskGraphParseError(result)).toBe(false)
    if (!isTaskGraphParseError(result)) {
      expect(result).toHaveLength(2)
      expect(result[1].dependencies).toEqual([{ taskId: 'TASK-001', impact: 'hard' }])
    }
  })

  it('tolerates a {"tasks": [...]} wrapper', () => {
    const raw = '```json\n' + JSON.stringify({ tasks: VALID_TASKS }) + '\n```'
    const result = parseTaskGraphJson(raw)
    expect(isTaskGraphParseError(result)).toBe(false)
    if (!isTaskGraphParseError(result)) {
      expect(result).toHaveLength(2)
    }
  })

  it('allows a forward reference to a task defined later in the same list', () => {
    const tasks = [
      { id: 'TASK-001', requirementIds: [], title: 'A', description: '', dependencies: [{ taskId: 'TASK-002', impact: 'soft' }], scope: {} },
      { id: 'TASK-002', requirementIds: [], title: 'B', description: '', dependencies: [], scope: {} }
    ]
    const result = parseTaskGraphJson('```json\n' + JSON.stringify(tasks) + '\n```')
    expect(isTaskGraphParseError(result)).toBe(false)
  })

  it('returns a parse error object instead of throwing on broken JSON', () => {
    const result = parseTaskGraphJson('```json\n[ this is not valid json\n```')
    expect(isTaskGraphParseError(result)).toBe(true)
  })

  it('returns a parse error when there is no JSON at all', () => {
    const result = parseTaskGraphJson('Tut mir leid, ich kann das nicht liefern.')
    expect(isTaskGraphParseError(result)).toBe(true)
  })

  it('returns a parse error for an empty task list', () => {
    const result = parseTaskGraphJson('```json\n[]\n```')
    expect(isTaskGraphParseError(result)).toBe(true)
  })

  it('returns a parse error when a task is missing a required field', () => {
    const raw = '```json\n' + JSON.stringify([{ title: 'Kein id-Feld' }]) + '\n```'
    const result = parseTaskGraphJson(raw)
    expect(isTaskGraphParseError(result)).toBe(true)
  })

  it('returns a parse error for an invalid dependency shape', () => {
    const raw =
      '```json\n' +
      JSON.stringify([{ id: 'TASK-001', title: 'A', dependencies: [{ taskId: 'TASK-002' }] }]) +
      '\n```'
    const result = parseTaskGraphJson(raw)
    expect(isTaskGraphParseError(result)).toBe(true)
  })

  it('fills in defaults for optional fields when absent', () => {
    const raw = '```json\n' + JSON.stringify([{ id: 'TASK-001', title: 'A' }]) + '\n```'
    const result = parseTaskGraphJson(raw)
    expect(isTaskGraphParseError(result)).toBe(false)
    if (!isTaskGraphParseError(result)) {
      expect(result[0].requirementIds).toEqual([])
      expect(result[0].description).toBe('')
      expect(result[0].dependencies).toEqual([])
      expect(result[0].scope.allowedPaths).toEqual([])
    }
  })
})
