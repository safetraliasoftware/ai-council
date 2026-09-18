import type { ChangeRequest, ProjectSpecification } from '@ai-council/project-domain'
import type { ExecutionTask, TaskDependency } from '@ai-council/task-graph'

/**
 * Two narrow Council calls for the ChangeRequest flow - deliberately not a
 * requirements-diff generator (that's projectSpec:generate's job, reused
 * unchanged) and not a full taskgraph regenerate (that's what destroys task
 * identity continuity - see the plan). This file only builds/parses: (1) a
 * proceed/reject verdict on the human's proposal, (2) replacement tasks for
 * whichever tasks a ChangeRequest actually invalidated.
 */

export interface ChangeRequestVerdict {
  recommendation: 'proceed' | 'reject'
  rationale: string
}

const EVALUATION_CONTRACT =
  '\nAntworte AUSSCHLIESSLICH als JSON: {"recommendation":"proceed|reject","rationale":"konkrete Begründung"}.'

export function buildChangeRequestReviewPrompt(
  cr: ChangeRequest,
  spec: ProjectSpecification,
  affectedTasks: ExecutionTask[]
): string {
  return [
    `Aktuelle Spezifikation:\nZiel: ${spec.goal}\nAnforderungen:\n${spec.requirements.map((r) => `- ${r.id} [${r.category}]: ${r.statement}`).join('\n')}`,
    `Betroffene Tasks:\n${affectedTasks.map((t) => `- ${t.id}: ${t.title} — ${t.description}`).join('\n')}`,
    `Grund der Eskalation:\n${cr.reason}`,
    cr.proposedChanges.trim() ? `Vorschlag des Menschen:\n${cr.proposedChanges}` : 'Noch kein menschlicher Vorschlag formuliert - beurteile allein anhand des Eskalationsgrunds.',
    'Bewerte, ob eine Spezifikationsänderung gerechtfertigt ist (proceed) oder die Eskalation anders gelöst werden sollte, z.B. durch eine andere Herangehensweise innerhalb der bestehenden Spezifikation (reject). Sei konkret in der Begründung.',
    EVALUATION_CONTRACT
  ]
    .filter(Boolean)
    .join('\n\n')
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return undefined
}

/** Same robust JSON-from-prose extraction as verification.ts's parseReviewVerdict - see its doc comment for what was caught live. */
export function parseChangeRequestVerdict(text: string): ChangeRequestVerdict {
  const trimmed = text.trim()
  const excerpt = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
  const block = extractJsonObject(trimmed)
  if (!block) throw new Error(`Council-Antwort enthält kein erkennbares JSON-Urteil. Antwort begann mit: "${excerpt}"`)
  let result: unknown
  try {
    result = JSON.parse(block)
  } catch (err) {
    throw new Error(
      `Council-JSON konnte nicht geparst werden: ${err instanceof Error ? err.message : String(err)}. Antwort begann mit: "${excerpt}"`
    )
  }
  const obj = result as Partial<ChangeRequestVerdict> | null
  if (!obj || (obj.recommendation !== 'proceed' && obj.recommendation !== 'reject') || typeof obj.rationale !== 'string' || !obj.rationale.trim()) {
    throw new Error('Council-Antwort enthält kein gültiges Urteil (erwartet: "recommendation": "proceed"|"reject" plus Begründung).')
  }
  return { recommendation: obj.recommendation, rationale: obj.rationale }
}

export interface ReplacementTask {
  replacesTaskId: string
  id: string
  requirementIds: string[]
  title: string
  description: string
  dependencies: TaskDependency[]
  scope: { allowedPaths: string[] }
}

export function buildReplacementTaskPrompt(
  invalidatedTasks: ExecutionTask[],
  spec: ProjectSpecification,
  cr: ChangeRequest
): string {
  return [
    `Diese Tasks wurden durch eine genehmigte Änderungsanfrage ungültig und müssen ersetzt werden:\n${invalidatedTasks.map((t) => `- ${t.id}: ${t.title} — ${t.description}`).join('\n')}`,
    `Aktuelle Spezifikation (Version ${spec.version}):\nZiel: ${spec.goal}\nAnforderungen:\n${spec.requirements.map((r) => `- ${r.id} [${r.category}]: ${r.statement}`).join('\n')}`,
    spec.architectureNotes ? `Architektur-Notizen:\n${spec.architectureNotes}` : '',
    `Grund der Änderung:\n${cr.reason}`,
    cr.proposedChanges.trim() ? `Vorschlag:\n${cr.proposedChanges}` : '',
    cr.councilRationale ? `Council-Einschätzung:\n${cr.councilRationale}` : '',
    'Erstelle NUR Ersatz-Tasks für die oben genannten ungültigen Tasks - nicht den ganzen Taskgraphen neu. Für jeden ungültigen Task mindestens einen Ersatz-Task; falls mehrere nötig sind, referenziere bei jedem dasselbe "replacesTaskId". Vergib neue, bisher nicht verwendete IDs.',
    'Antworte AUSSCHLIESSLICH mit einem JSON-Array in einem ```json-Codeblock, exakt in diesem Schema:\n```json\n[{"replacesTaskId":"alte-id","id":"TASK-NEU-1","requirementIds":["REQ-001"],"title":"...","description":"...","dependencies":[{"taskId":"...","impact":"hard|soft"}],"scope":{"allowedPaths":["..."]}}]\n```'
  ]
    .filter(Boolean)
    .join('\n\n')
}

function extractJsonArray(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1]
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return undefined
}

function isValidDependency(value: unknown): value is TaskDependency {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.taskId === 'string' && (obj.impact === 'hard' || obj.impact === 'soft')
}

/**
 * `validReplacesIds` guards against the model inventing a `replacesTaskId`
 * that doesn't correspond to any task it was actually asked to replace -
 * caught silently otherwise, since a bogus id would just fail later at
 * TaskGraph.updateTask() with a much less specific error.
 */
export function parseReplacementTasks(text: string, validReplacesIds: string[]): ReplacementTask[] {
  const trimmed = text.trim()
  const excerpt = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
  const block = extractJsonArray(trimmed)
  if (!block) throw new Error(`Ersatz-Tasks: kein JSON-Array gefunden. Antwort begann mit: "${excerpt}"`)
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (err) {
    throw new Error(
      `Ersatz-Tasks: JSON konnte nicht geparst werden: ${err instanceof Error ? err.message : String(err)}. Antwort begann mit: "${excerpt}"`
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Ersatz-Tasks: leeres oder ungültiges Array.')

  return parsed.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`Ersatz-Task ${i + 1} ist kein Objekt.`)
    const obj = raw as Record<string, unknown>
    if (typeof obj.id !== 'string' || !obj.id) throw new Error(`Ersatz-Task ${i + 1} hat keine gültige "id".`)
    if (typeof obj.title !== 'string' || !obj.title) throw new Error(`Ersatz-Task "${obj.id}" hat keinen gültigen "title".`)
    if (typeof obj.replacesTaskId !== 'string' || !validReplacesIds.includes(obj.replacesTaskId)) {
      throw new Error(
        `Ersatz-Task "${obj.id}" hat kein gültiges "replacesTaskId" (erwartet einen der ungültig gewordenen Tasks: ${validReplacesIds.join(', ')}).`
      )
    }
    const dependenciesRaw = Array.isArray(obj.dependencies) ? obj.dependencies : []
    if (!dependenciesRaw.every(isValidDependency)) {
      throw new Error(`Ersatz-Task "${obj.id}" hat eine ungültige Abhängigkeit (erwartet {taskId, impact: "hard"|"soft"}).`)
    }
    const scopeRaw = typeof obj.scope === 'object' && obj.scope !== null ? (obj.scope as Record<string, unknown>) : {}
    for (const [field, value] of Object.entries({ requirementIds: obj.requirementIds, allowedPaths: scopeRaw.allowedPaths })) {
      if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
        throw new Error(`Ersatz-Task "${obj.id}": "${field}" muss eine Liste von Zeichenketten sein.`)
      }
    }
    return {
      replacesTaskId: obj.replacesTaskId,
      id: obj.id,
      title: obj.title,
      description: typeof obj.description === 'string' ? obj.description : '',
      requirementIds: Array.isArray(obj.requirementIds) ? (obj.requirementIds as string[]) : [],
      dependencies: dependenciesRaw as TaskDependency[],
      scope: { allowedPaths: Array.isArray(scopeRaw.allowedPaths) ? (scopeRaw.allowedPaths as string[]) : [] }
    }
  })
}
