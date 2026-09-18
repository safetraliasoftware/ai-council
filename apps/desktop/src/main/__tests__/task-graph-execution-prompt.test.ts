import { describe, expect, it } from 'vitest'
import type { ProjectSpecification } from '@ai-council/project-domain'
import type { ExecutionTask } from '@ai-council/task-graph'
import { buildTaskExecutionPrompt } from '../task-graph-execution-prompt'

function fixtureSpec(overrides: Partial<ProjectSpecification> = {}): ProjectSpecification {
  return {
    id: 'proj-1',
    version: 1,
    goal: 'Dienstplan-App bauen',
    requirements: [
      { id: 'REQ-001', category: 'feature', statement: 'Schichten planen', acceptanceCriteria: ['Nutzer kann eine Schicht anlegen', 'Überschneidungen werden verhindert'] },
      { id: 'REQ-002', category: 'security', statement: 'Zugriffsschutz', acceptanceCriteria: ['Nur eingeloggte Nutzer sehen Schichten'] }
    ],
    nonGoals: [],
    architectureNotes: '',
    risks: [],
    openQuestions: [],
    chairId: 'anthropic',
    rawSynthesisText: '{}',
    status: 'human_approved',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

function fixtureTask(overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id: 'TASK-001',
    specVersion: 1,
    requirementIds: ['REQ-001'],
    title: 'Datenmodell anlegen',
    description: 'Schicht-Entität definieren',
    dependencies: [],
    scope: { allowedPaths: ['src/domain/**'] },
    status: 'pending',
    ...overrides
  }
}

describe('buildTaskExecutionPrompt', () => {
  it('includes the task title and description', () => {
    const prompt = buildTaskExecutionPrompt(fixtureTask(), fixtureSpec())
    expect(prompt).toContain('Datenmodell anlegen')
    expect(prompt).toContain('Schicht-Entität definieren')
  })

  it('includes the project goal as context', () => {
    const prompt = buildTaskExecutionPrompt(fixtureTask(), fixtureSpec())
    expect(prompt).toContain('Dienstplan-App bauen')
  })

  it('includes only the acceptance criteria of requirements the task actually references', () => {
    const prompt = buildTaskExecutionPrompt(fixtureTask({ requirementIds: ['REQ-001'] }), fixtureSpec())
    expect(prompt).toContain('Nutzer kann eine Schicht anlegen')
    expect(prompt).not.toContain('Nur eingeloggte Nutzer sehen Schichten')
  })

  it('includes the allowedPaths scope guardrail when present', () => {
    const prompt = buildTaskExecutionPrompt(fixtureTask({ scope: { allowedPaths: ['src/domain/**'] } }), fixtureSpec())
    expect(prompt).toContain('src/domain/**')
    expect(prompt).toMatch(/bleibe innerhalb/)
  })

  it('omits the scope guardrail section when allowedPaths is empty', () => {
    const prompt = buildTaskExecutionPrompt(fixtureTask({ scope: { allowedPaths: [] } }), fixtureSpec())
    expect(prompt).not.toMatch(/Erlaubter Bereich/)
  })

  it('does not include an EXECUTION_CONTEXT_NOTE-style read-only disclaimer (the executor has real write access here)', () => {
    const prompt = buildTaskExecutionPrompt(fixtureTask(), fixtureSpec())
    expect(prompt).not.toMatch(/schreibgeschützten Beratungsmodus/)
  })
})
