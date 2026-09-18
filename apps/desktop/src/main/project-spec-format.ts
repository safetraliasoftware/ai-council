import type { ProjectSpecification } from '@ai-council/project-domain'
import { WORKFLOW_GUIDANCE, planningGuidance } from './workflow-guidance'

/**
 * The JSON-schema instruction lives in the prompt TEXT, not in
 * systemInstructions - council-core's critique/synthesis rounds rebuild a
 * bare request that drops systemInstructions entirely (verified against
 * packages/council-core/src/orchestrator/council.ts), so only text folded
 * into the prompt survives all three rounds. Documented technical debt:
 * once council-core gains an outputContract/synthesisInstructions concept,
 * this workaround should be replaced by that instead.
 */
const SCHEMA_INSTRUCTION = `Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in einem \`\`\`json-Codeblock, exakt in diesem Schema (keine zusätzlichen Felder, kein Fließtext davor oder danach):

\`\`\`json
{
  "requirements": [
    {
      "id": "REQ-001",
      "category": "feature | security | compliance | architecture",
      "statement": "...",
      "acceptanceCriteria": ["..."],
      "priority": "must | should | could"
    }
  ],
  "nonGoals": ["..."],
  "architectureNotes": "...",
  "risks": ["..."],
  "openQuestions": [
    { "text": "...", "blocking": true }
  ]
}
\`\`\``

/**
 * Caught live: a local-agent council participant (forced read-only for
 * this call - see packages/council-participants) proposed a task to "make
 * the workspace writable" as if that were a real project requirement,
 * confusing its own temporary, safety-enforced restriction for THIS
 * planning call with a property of the eventual target project. The chair
 * self-corrected in synthesis that time, but the confusion cost a wasted
 * critique-round cycle - this note heads it off instead of relying on
 * synthesis to catch it every time.
 */
const EXECUTION_CONTEXT_NOTE =
  'Hinweis zu deiner eigenen aktuellen Ausführung: Du beantwortest diese Anfrage gerade in einem schreibgeschützten Beratungsmodus - das ist eine Sicherheitsmaßnahme nur für diesen Planungsaufruf und sagt NICHTS über die spätere echte Umgebung aus, in der das Projekt tatsächlich implementiert wird. Gehe davon aus, dass die Implementierung in einer normalen, beschreibbaren Entwicklungsumgebung stattfindet. Erstelle keine Anforderung oder Task, die sich mit deinem eigenen Lesezugriff in diesem Gespräch befasst.'

export function buildProjectSpecPrompt(goal: string, previous?: ProjectSpecification, userNote?: string, profile: 'simple' | 'standard' = 'standard'): string {
  const context = previous ? [
    'Überarbeite die folgende bisherige Spezifikation. Erhalte unveränderte Anforderungen mit ihren IDs und Akzeptanzkriterien sowie Architekturentscheidungen, Nicht-Ziele und Risiken. Ändere sie nur, soweit das aktuelle Projektziel oder die Änderungsnotiz dies erfordert. Berücksichtige beantwortete offene Fragen. Liefere die vollständige neue Spezifikation, nicht nur die Änderungen.',
    JSON.stringify({ version: previous.version, status: previous.status, goal: previous.goal,
      requirements: previous.requirements, nonGoals: previous.nonGoals, architectureNotes: previous.architectureNotes,
      risks: previous.risks, openQuestions: previous.openQuestions })
  ].join('\n') : ''
  return [`Aufgabe: ${goal}`, context, userNote ? `Änderungsnotiz des Nutzers:\n${userNote}` : '', EXECUTION_CONTEXT_NOTE, WORKFLOW_GUIDANCE, planningGuidance(profile), SCHEMA_INSTRUCTION].filter(Boolean).join('\n\n')
}

export interface ProjectSpecParseError {
  error: string
  rawText: string
}

export type ParsedProjectSpecFields = Pick<
  ProjectSpecification,
  'requirements' | 'nonGoals' | 'architectureNotes' | 'risks' | 'openQuestions'
>

function extractJsonBlock(rawText: string): string | undefined {
  const fenced = rawText.match(/```json\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1]
  const braceStart = rawText.indexOf('{')
  const braceEnd = rawText.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) return rawText.slice(braceStart, braceEnd + 1)
  return undefined
}

export function parseProjectSpecJson(rawText: string): ParsedProjectSpecFields | ProjectSpecParseError {
  const block = extractJsonBlock(rawText)
  if (!block) return { error: 'Kein JSON-Block in der Antwort gefunden.', rawText }

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (err) {
    return {
      error: `JSON konnte nicht geparst werden: ${err instanceof Error ? err.message : String(err)}`,
      rawText
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { error: 'Antwort ist kein JSON-Objekt.', rawText }
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.requirements)) {
    return { error: 'Pflichtfeld "requirements" fehlt oder ist kein Array.', rawText }
  }
  const ids = new Set<string>()
  for (const requirement of obj.requirements) {
    if (!requirement || typeof requirement.id !== 'string' || !requirement.id.trim() || ids.has(requirement.id) ||
        !['feature', 'security', 'compliance', 'architecture'].includes(requirement.category) ||
        typeof requirement.statement !== 'string' || !requirement.statement.trim() ||
        !Array.isArray(requirement.acceptanceCriteria) || !requirement.acceptanceCriteria.length ||
        requirement.acceptanceCriteria.some((c: unknown) => typeof c !== 'string' || !c.trim()) ||
        (requirement.priority !== undefined && !['must', 'should', 'could'].includes(requirement.priority))) {
      return { error: 'Ungültiges Requirement: eindeutige ID, Kategorie, Beschreibung, Akzeptanzkriterien und gültige Priorität erforderlich.', rawText }
    }
    ids.add(requirement.id)
    requirement.priority ??= 'must'
  }

  return {
    requirements: obj.requirements as ProjectSpecification['requirements'],
    nonGoals: Array.isArray(obj.nonGoals) ? (obj.nonGoals as string[]) : [],
    architectureNotes: typeof obj.architectureNotes === 'string' ? obj.architectureNotes : '',
    risks: Array.isArray(obj.risks) ? (obj.risks as string[]) : [],
    openQuestions: Array.isArray(obj.openQuestions)
      ? (obj.openQuestions as ProjectSpecification['openQuestions'])
      : []
  }
}

export function isProjectSpecParseError(
  result: ParsedProjectSpecFields | ProjectSpecParseError
): result is ProjectSpecParseError {
  return 'error' in result
}
