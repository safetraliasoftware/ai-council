import type { ProjectSpecification } from '@ai-council/project-domain'
import type { ExecutionTask } from '@ai-council/task-graph'
import { WORKFLOW_GUIDANCE } from './workflow-guidance'

/**
 * Unlike task-graph-format.ts/project-spec-format.ts, no EXECUTION_CONTEXT_NOTE
 * is needed here - those prompts had to clarify that the model's own forced
 * read-only mode during PLANNING calls says nothing about the real target
 * environment. Here the executor runs with real write access inside an
 * isolated git worktree from the start, so there's no read-only-mode
 * confusion to pre-empt.
 */
export function buildTaskExecutionPrompt(task: ExecutionTask, spec: ProjectSpecification): string {
  const acceptanceCriteria = spec.requirements
    .filter((r) => task.requirementIds.includes(r.id))
    .flatMap((r) => r.acceptanceCriteria.map((c) => `- [${r.id}] ${c}`))
    .join('\n')

  const allowedPaths = task.scope.allowedPaths
  const scopeNote =
    allowedPaths.length > 0
      ? `Erlaubter Bereich für diese Änderung (bleibe innerhalb dieser Pfad-Muster):\n${allowedPaths.map((p) => `- ${p}`).join('\n')}\n\nFalls die Aufgabe ohne Änderungen außerhalb dieses Bereichs nicht lösbar ist, melde das explizit in deiner Zusammenfassung statt den Bereich stillschweigend zu überschreiten.`
      : ''

  return [
    WORKFLOW_GUIDANCE,
    'Implementiere und prüfe das geforderte Verhalten vollständig im erlaubten Bereich. Behebe lokale Vertragslücken, defensive Kopien und numerische Grenzfälle selbst. Ergänze gezielte Verhaltenstests für solche Fehler. Ein erfolgreicher Build oder ein Testlauf mit null Tests belegt das Verhalten nicht. Bereits genehmigte Produktentscheidungen dürfen dabei nicht geändert werden.',
    `Projektziel (Kontext, nicht dieser einzelne Task):\n${spec.goal}`,
    `Aktueller Task: ${task.title}\n\n${task.description}`,
    `Verbindliche Architekturentscheidungen:\n${spec.architectureNotes}`,
    `Nicht-Ziele:\n${spec.nonGoals.join('\n')}`,
    `Risiken:\n${spec.risks.join('\n')}`,
    acceptanceCriteria ? `Akzeptanzkriterien:\n${acceptanceCriteria}` : '',
    scopeNote
  ]
    .filter(Boolean)
    .join('\n\n')
}
