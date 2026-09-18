/**
 * Shared marker between how claude-code-cli.ts/google-antigravity-cli.ts
 * already format a denied-action warning and how project-engine.ts detects
 * one to offer a permission-elevation prompt - keeps producer and consumer
 * from drifting into two independently-hand-written strings. Deliberately
 * NOT a new CodingExecutorEvent variant (that would ripple into
 * agent-participant.ts/codingEventDisplay.tsx/TaskCoding.tsx/TaskWorkflow.tsx,
 * none of which need to know about this) - it's still the same plain
 * `warning` event, just one with a recognizable, app-authored shape.
 */
const PERMISSION_DENIAL_MARKER = 'wurden verweigert (keine Freigabe im aktuellen Rechte-Level): '

export function formatPermissionDenialWarning(kind: string, count: number, names: string[]): string {
  return `${count} ${kind} ${PERMISSION_DENIAL_MARKER}${names.join(', ')}`
}

export function parsePermissionDenialWarning(message: string): string[] | undefined {
  const idx = message.indexOf(PERMISSION_DENIAL_MARKER)
  if (idx === -1) return undefined
  const names = message
    .slice(idx + PERMISSION_DENIAL_MARKER.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return names.length ? names : undefined
}
