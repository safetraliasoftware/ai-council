import type { ProjectSpecification, TaskGraphSnapshot } from './types'

export type ProjectPhase = 'planning' | 'execution' | 'integration_review' | 'release_approval' | 'done' | 'halted'
export interface CommandSpec { executable: string; args: string[]; timeoutMs: number }
export interface CommandResult {
  command: CommandSpec; exitCode: number | null; stdout: string; stderr: string; durationMs: number
  success: boolean; timedOut: boolean; aborted: boolean; killConfirmed: boolean
  /** Set when the spawn itself failed with ENOENT - the executable isn't installed/on PATH, not a real test/build failure. */
  missingExecutable?: boolean
}
export interface Finding { severity: 'critical' | 'high' | 'medium' | 'low'; message: string; file?: string; requirementId?: string }
export interface Verdict { verdict: 'pass' | 'fail' | 'escalate'; findings: Finding[]; suggestions?: Finding[]; reason?: string; resolution?: 'implementation' | 'user_decision' }
export interface WorkspaceRef { path: string; branch: string; sourceRepo: string }
export type TaskFailureKind = 'authentication' | 'quota' | 'process' | 'budget' | 'cancelled' | 'implementation' | 'policy' | 'storage'
export interface TaskBudget { maxCalls: number; maxActiveMs: number; maxCorrections: number }
export const DEFAULT_TASK_BUDGET: TaskBudget = { maxCalls: 8, maxActiveMs: 30 * 60_000, maxCorrections: 2 }
export interface AgentCallMetric {
  id: string; executorId: string; stage: string; startedAt: number; finishedAt?: number
  outcome: 'running' | 'completed' | 'failed'; inputChars: number; outputChars: number
  costUsd?: number; inputTokens?: number; outputTokens?: number
}
export interface TaskRuntime {
  failureKind?: TaskFailureKind; stage?: string; activeMs: number; corrections: number
  calls: AgentCallMetric[]; checkpoint?: 'implement' | 'fix' | 'review'; retryable?: boolean
}
export interface TaskAttempt {
  runtime?: TaskRuntime
  id: string; taskId: string; specVersion: number; startedAt: number; finishedAt?: number
  status: 'running' | 'review' | 'failed' | 'interrupted' | 'accepted' | 'discarded' | 'escalated' | 'awaiting_permission' | 'awaiting_install' | 'paused'
  implementerId: string; reviewerId: string; challengerId?: string
  worktree?: WorkspaceRef; verification: CommandResult[]; reviews: Verdict[]
  fingerprint?: string; events: unknown[]; error?: string; commit?: string
  context?: string
  /** Persisted checkpoint for retrying a failed review in the same workspace. */
  reviewPending?: boolean
  /** Completed individual reviews of this exact input, retained only across technical interruptions. */
  reviewCheckpoint?: { key: string; results: Record<string, Verdict> }
  taskStartCommit?: string
  integrationWorktrees?: WorkspaceRef[]
  /** Set while status is 'awaiting_permission' - what the implementer was denied and is asking to be granted (permissionTier 'full') to retry. */
  pendingPermissionActions?: string[]
  /** Set while status is 'awaiting_install' - which executable a verification check couldn't find, and a best-effort (human-editable, never auto-run) suggested install command. */
  pendingInstallAction?: { executable: string; suggestedCommand?: CommandSpec }
}
export interface ProjectExecution {
  taskBudgets?: Record<string, TaskBudget>
  budget?: TaskBudget
  projectId: string; runId: string; specVersion: number; phase: ProjectPhase
  commands: CommandSpec[]; maxAttempts: number; attempts: TaskAttempt[]
  archivedAttempts?: TaskAttempt[]
  integration?: WorkspaceRef; sourceBranch?: string; sourceHead?: string
  finalVerification?: CommandResult[]; finalVerdict?: Verdict; releaseCommit?: string
  haltReason?: string; updatedAt: number
}

/** Explicit retries may continue a reviewed implementation, never a policy violation. */
export function canResumeTaskCorrection(attempt: TaskAttempt | undefined, specVersion: number): boolean {
  return !!attempt && attempt.status === 'failed' && !attempt.reviewPending && !attempt.commit &&
    !!attempt.worktree && !!attempt.taskStartCommit && attempt.specVersion === specVersion &&
    !!attempt.error?.startsWith('Prüfungen oder Reviews weiterhin fehlgeschlagen.') &&
    attempt.reviews.some(r => r.verdict === 'fail') && !attempt.reviews.some(r => r.verdict === 'escalate')
}

/** Explicitly reverify a changed review workspace; never reuse its old approval. */
export function canRecheckReviewWorkspace(attempt: TaskAttempt | undefined, specVersion: number): boolean {
  return !!attempt && attempt.status === 'failed' && !attempt.commit && !!attempt.worktree &&
    !!attempt.taskStartCommit && attempt.specVersion === specVersion &&
    !!attempt.error?.startsWith('POLICY VIOLATION: Das Arbeitsverzeichnis hat sich während eines schreibgeschützten Laufs verändert:')
}

/** These gates are pure domain rules, usable by any UI or host. */
export function requireApprovedSpecification(spec: ProjectSpecification | undefined, graph: TaskGraphSnapshot): void {
  if (!spec || spec.status !== 'human_approved' || spec.version !== graph.specVersion || spec.id !== graph.projectId) {
    throw new Error('Die passende Projekt-Spezifikation muss zuerst vom Menschen freigegeben werden.')
  }
  if (graph.status !== 'human_approved') throw new Error('Der Taskgraph ist nicht freigegeben.')
}
export function requireVerifiedAttempt(attempt: TaskAttempt | undefined): asserts attempt is TaskAttempt {
  if (!attempt || attempt.status !== 'review' || !attempt.fingerprint || !attempt.verification.length ||
      attempt.verification.some(v => !v.success) || !attempt.reviews.length ||
      attempt.reviews.some(r => r.verdict !== 'pass' || r.findings.length)) {
    throw new Error('Annahme blockiert: erfolgreiche Pflichtprüfungen und Reviews für diesen Stand fehlen.')
  }
}
export function requireReleaseReady(state: ProjectExecution, graph: TaskGraphSnapshot): void {
  // Same reasoning as finalReview()'s matching check in project-engine.ts:
  // 'invalidated' tasks are correctly-superseded history from an applied
  // ChangeRequest, not outstanding work - they must not block release.
  if (state.phase !== 'release_approval' || !state.releaseCommit ||
      !graph.tasks.length || graph.tasks.some(t => t.status !== 'accepted' && t.status !== 'invalidated') ||
      !state.finalVerification?.length || state.finalVerification.some(v => !v.success) ||
      state.finalVerdict?.verdict !== 'pass' || state.finalVerdict.findings.length) {
    throw new Error('Release blockiert: Gesamtprüfung und finales Council müssen erfolgreich abgeschlossen sein.')
  }
}

/** Portable path glob matcher: ** matches segments, * and ? match within a segment. */
export function isWithinScope(path: string, patterns: string[]): boolean {
  const segments = path.replace(/\\/g, '/').split('/')
  if (segments.includes('..') || path.startsWith('/') || /^[a-z]:/i.test(path)) return false
  if (!patterns.length) return true // Legacy tasks did not declare a scope.
  const match = (parts: string[], index: number, position: number): boolean => {
    if (index === parts.length) return position === segments.length
    if (parts[index] === '**') return match(parts, index + 1, position) || (position < segments.length && match(parts, index, position + 1))
    const regex = parts[index].split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
    return position < segments.length && new RegExp(`^${regex}$`).test(segments[position]) && match(parts, index + 1, position + 1)
  }
  return patterns.some(pattern => match(pattern.replace(/\\/g, '/').replace(/^\.\//, '').split('/'), 0, 0))
}

/**
 * Same decision shape as @ai-council/coding's PolicyDecision (structurally,
 * not imported - project-domain deliberately doesn't depend on coding for
 * one shared type). Wraps isWithinScope() so project-engine's scope
 * enforcement is expressed the same way as its workspace-integrity check.
 */
export function checkScope(changedPaths: string[], allowedPaths: string[]): { outcome: 'allow' | 'deny'; reason?: string } {
  const outside = changedPaths.filter(p => !isWithinScope(p, allowedPaths))
  return outside.length
    ? { outcome: 'deny', reason: `Änderungen außerhalb des freigegebenen Scopes: ${outside.join(', ')}` }
    : { outcome: 'allow' }
}
