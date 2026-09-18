import { describe, expect, it } from 'vitest'
import { buildProjectSpecPrompt, isProjectSpecParseError, parseProjectSpecJson } from '../project-spec-format'

describe('buildProjectSpecPrompt', () => {
  it('includes the raw goal and a JSON schema instruction', () => {
    const prompt = buildProjectSpecPrompt('Baue eine Dienstplan-App')
    expect(prompt).toContain('Baue eine Dienstplan-App')
    expect(prompt).toContain('```json')
    expect(prompt).toContain('requirements')
  })

  it('REGRESSION (read-only-mode confusion): clarifies that its own read-only execution is not a property of the target project', () => {
    // Caught live: a local-agent council participant proposed a task to
    // "make the workspace writable", confusing its own temporary,
    // safety-enforced read-only restriction for this planning call with a
    // real constraint of the eventual project.
    const prompt = buildProjectSpecPrompt('Baue eine Dienstplan-App')
    expect(prompt).toMatch(/schreibgeschützten Beratungsmodus/)
  })
})

const VALID_JSON = {
  requirements: [
    { id: 'REQ-001', category: 'feature', statement: 'Schichten anlegen', acceptanceCriteria: ['Nutzer kann eine Schicht speichern'] }
  ],
  nonGoals: ['Keine native iOS-App'],
  architectureNotes: 'Kotlin, lokale Datenbank',
  risks: ['Zeitzonen-Handling'],
  openQuestions: [{ text: 'Welche Datenbank?', blocking: true }]
}

describe('parseProjectSpecJson', () => {
  it('extracts and parses a clean ```json code block', () => {
    const raw = '```json\n' + JSON.stringify(VALID_JSON) + '\n```'
    const result = parseProjectSpecJson(raw)
    expect(isProjectSpecParseError(result)).toBe(false)
    if (!isProjectSpecParseError(result)) {
      expect(result.requirements).toHaveLength(1)
      expect(result.requirements[0].id).toBe('REQ-001')
      expect(result.openQuestions).toEqual([{ text: 'Welche Datenbank?', blocking: true }])
    }
  })

  it('extracts JSON even when the model added prose around it', () => {
    const raw = `Hier ist die Spezifikation:\n\n${JSON.stringify(VALID_JSON)}\n\nIch hoffe das hilft!`
    const result = parseProjectSpecJson(raw)
    expect(isProjectSpecParseError(result)).toBe(false)
    if (!isProjectSpecParseError(result)) {
      expect(result.requirements).toHaveLength(1)
    }
  })

  it('returns a parse error object instead of throwing on broken JSON', () => {
    const result = parseProjectSpecJson('```json\n{ this is not valid json\n```')
    expect(isProjectSpecParseError(result)).toBe(true)
    if (isProjectSpecParseError(result)) {
      expect(result.rawText).toContain('this is not valid json')
    }
  })

  it('returns a parse error object when there is no JSON at all', () => {
    const result = parseProjectSpecJson('Tut mir leid, ich kann das nicht als JSON liefern.')
    expect(isProjectSpecParseError(result)).toBe(true)
  })

  it('returns a parse error when the required "requirements" field is missing', () => {
    const raw = '```json\n{"nonGoals": []}\n```'
    const result = parseProjectSpecJson(raw)
    expect(isProjectSpecParseError(result)).toBe(true)
  })

  it('fills in defaults for optional fields when absent', () => {
    const raw = '```json\n{"requirements": []}\n```'
    const result = parseProjectSpecJson(raw)
    expect(isProjectSpecParseError(result)).toBe(false)
    if (!isProjectSpecParseError(result)) {
      expect(result.nonGoals).toEqual([])
      expect(result.risks).toEqual([])
      expect(result.openQuestions).toEqual([])
      expect(result.architectureNotes).toBe('')
    }
  })
})
