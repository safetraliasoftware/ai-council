import type { ProjectSpecification } from '@ai-council/project-domain'
import { WORKFLOW_GUIDANCE, planningGuidance } from './workflow-guidance'
import type { ExecutionTask, TaskDependency, TaskScope } from '@ai-council/task-graph'

/**
 * Same reasoning as project-spec-format.ts: the schema instruction lives in
 * the prompt text, not systemInstructions, since council-core's critique/
 * synthesis rounds drop systemInstructions entirely. Documented technical
 * debt there applies here too.
 */
const SCHEMA_INSTRUCTION = `Zerlege dieses Projekt in einzelne, abhängigkeitsbewusste Tasks. Antworte AUSSCHLIESSLICH mit einem JSON-Array in einem \`\`\`json-Codeblock, exakt in diesem Schema (keine zusätzlichen Felder, kein Fließtext davor oder danach):

\`\`\`json
[
  {
    "id": "TASK-001",
    "requirementIds": ["REQ-001"],
    "title": "...",
    "description": "...",
    "dependencies": [
      { "taskId": "TASK-000", "impact": "hard | soft" }
    ],
    "scope": {
      "allowedPaths": ["..."],
      "suspectedFiles": ["..."],
      "readOnlyContext": ["..."]
    }
  }
]
\`\`\`

Wichtig:
- "id" ist ein eindeutiger String je Task ("TASK-001", "TASK-002", ...).
- "dependencies" darf auf jede andere "id" in dieser Liste verweisen, auch auf eine, die später in der Liste steht (Vorwärtsreferenzen sind erlaubt).
- "impact" entscheidet NICHT, ob ein Task ohne seine Abhängigkeit starten darf - jede Abhängigkeit, "hard" wie "soft", muss abgeschlossen sein, bevor der Task beginnen kann. "impact" wirkt sich erst aus, wenn sich der abhängige Task SPÄTER, nach Abschluss, nochmal ändert: "hard" macht diesen Task dann ungültig, "soft" markiert ihn nur zur erneuten Prüfung. Wenn ein Task wirklich unabhängig starten können soll, gib ihm keine Abhängigkeit dorthin.
- "allowedPaths" ist der Bereich, in dem der Task arbeiten darf (Glob-artige Pfad-Muster, z. B. "src/domain/**").
- Erfinde keine "status"- oder "specVersion"-Felder - die werden nicht von dir erwartet.`

/** Same reasoning as project-spec-format.ts's identical note - see there for what was caught live. */
const EXECUTION_CONTEXT_NOTE =
  'Hinweis zu deiner eigenen aktuellen Ausführung: Du beantwortest diese Anfrage gerade in einem schreibgeschützten Beratungsmodus - das ist eine Sicherheitsmaßnahme nur für diesen Planungsaufruf und sagt NICHTS über die spätere echte Umgebung aus, in der die Tasks tatsächlich ausgeführt werden. Gehe davon aus, dass jeder Task in einer normalen, beschreibbaren Entwicklungsumgebung läuft. Erstelle keinen Task, der sich mit deinem eigenen Lesezugriff in diesem Gespräch befasst.'

export function buildTaskGraphPrompt(spec: ProjectSpecification, profile: 'simple' | 'standard' = 'standard'): string {
  const requirementsBlock = spec.requirements
    .map((r) => `- ${r.id} [${r.category}]: ${r.statement}\n${r.acceptanceCriteria.map(c => `  Akzeptanz: ${c}`).join('\n')}`)
    .join('\n')

  return [
    `Ziel des Projekts:\n${spec.goal}`,
    `Anforderungen:\n${requirementsBlock}`,
    EXECUTION_CONTEXT_NOTE,
    WORKFLOW_GUIDANCE,
    planningGuidance(profile),
    'Plane vertikale, direkt prüfbare Funktionen mit den jeweils nötigen Typen, Fehlerfällen und Tests gemeinsam. Erlaubte Pfade müssen auch die zugehörigen Tests und nötige Projektkonfiguration abdecken. Bei kleinen Apps meist 1–3 Tasks; mehr nur bei tatsächlicher Komplexität. Keine künstlichen Abhängigkeiten zwischen bloßen Dokumentations- oder Typdefinitions-Tasks.',
    spec.architectureNotes ? `Architektur-Notizen:\n${spec.architectureNotes}` : '',
    spec.nonGoals.length > 0 ? `Nicht-Ziele:\n${spec.nonGoals.map((n) => `- ${n}`).join('\n')}` : '',
    spec.risks.length > 0 ? `Risiken:\n${spec.risks.map((r) => `- ${r}`).join('\n')}` : '',
    SCHEMA_INSTRUCTION
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface TaskGraphParseError {
  error: string
  rawText: string
}

export type ParsedTask = Pick<ExecutionTask, 'id' | 'requirementIds' | 'title' | 'description'> & {
  dependencies: TaskDependency[]
  scope: TaskScope
}

function extractJsonBlock(rawText: string): string | undefined {
  const fenced = rawText.match(/```json\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1]
  const bracketStart = rawText.indexOf('[')
  const bracketEnd = rawText.lastIndexOf(']')
  if (bracketStart >= 0 && bracketEnd > bracketStart) return rawText.slice(bracketStart, bracketEnd + 1)
  return undefined
}

function isValidDependency(value: unknown): value is TaskDependency {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.taskId === 'string' && (obj.impact === 'hard' || obj.impact === 'soft')
}

function parseOneTask(raw: unknown, index: number): ParsedTask | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: `Task ${index + 1} ist kein Objekt.` }
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id) {
    return { error: `Task ${index + 1} hat keine gültige "id".` }
  }
  if (typeof obj.title !== 'string' || !obj.title) {
    return { error: `Task "${obj.id}" hat keinen gültigen "title".` }
  }

  const dependenciesRaw = Array.isArray(obj.dependencies) ? obj.dependencies : []
  if (!dependenciesRaw.every(isValidDependency)) {
    return { error: `Task "${obj.id}" hat eine ungültige Abhängigkeit (erwartet {taskId, impact: "hard"|"soft"}).` }
  }

  const scopeRaw = typeof obj.scope === 'object' && obj.scope !== null ? (obj.scope as Record<string, unknown>) : {}
  for (const [field, value] of Object.entries({ requirementIds: obj.requirementIds,
    allowedPaths: scopeRaw.allowedPaths, suspectedFiles: scopeRaw.suspectedFiles, readOnlyContext: scopeRaw.readOnlyContext })) {
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      return { error: `Task "${obj.id}": "${field}" muss eine Liste von Zeichenketten sein.` }
    }
  }

  return {
    id: obj.id,
    requirementIds: Array.isArray(obj.requirementIds) ? (obj.requirementIds as string[]) : [],
    title: obj.title,
    description: typeof obj.description === 'string' ? obj.description : '',
    dependencies: dependenciesRaw as TaskDependency[],
    scope: {
      allowedPaths: Array.isArray(scopeRaw.allowedPaths) ? (scopeRaw.allowedPaths as string[]) : [],
      suspectedFiles: Array.isArray(scopeRaw.suspectedFiles) ? (scopeRaw.suspectedFiles as string[]) : undefined,
      readOnlyContext: Array.isArray(scopeRaw.readOnlyContext) ? (scopeRaw.readOnlyContext as string[]) : undefined
    }
  }
}

export function parseTaskGraphJson(rawText: string): ParsedTask[] | TaskGraphParseError {
  const block = extractJsonBlock(rawText)
  if (!block) return { error: 'Kein JSON-Array in der Antwort gefunden.', rawText }

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (err) {
    return {
      error: `JSON konnte nicht geparst werden: ${err instanceof Error ? err.message : String(err)}`,
      rawText
    }
  }

  // Tolerate a {"tasks": [...]} wrapper in case the model adds one despite the instruction.
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).tasks)
      ? ((parsed as Record<string, unknown>).tasks as unknown[])
      : undefined

  if (!list) return { error: 'Antwort ist kein JSON-Array von Tasks.', rawText }
  if (list.length === 0) return { error: 'Die Task-Liste ist leer.', rawText }

  const tasks: ParsedTask[] = []
  for (let i = 0; i < list.length; i++) {
    const result = parseOneTask(list[i], i)
    if ('error' in result) return { error: result.error, rawText }
    tasks.push(result)
  }
  return tasks
}

export function isTaskGraphParseError(
  result: ParsedTask[] | TaskGraphParseError
): result is TaskGraphParseError {
  return !Array.isArray(result)
}
