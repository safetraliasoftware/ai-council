import type { ProviderId } from '@ai-council/shared'
import type {
  CodingExecutorEvent,
  GitDiffResult,
  PermissionTier,
  PipelineConfig,
  WorkflowEvent,
  WorkflowStage,
  WorktreeInfo
} from '@ai-council/coding'
import type { ChangeRequest, ChangeRequestSeverity, CommandSpec, ProjectSpecification, TaskGraphSnapshot } from '@ai-council/project-domain'
import type { ParticipantBackendChoice } from './backend-config'

export type { ParticipantBackendChoice } from './backend-config'

export interface ProviderSettingsEntry {
  hasKey: boolean
  model: string
  /** Which backend Compare/Team/Council/ProjectSpecification uses for this provider. */
  backend: ParticipantBackendChoice
}

export type SettingsState = Record<ProviderId, ProviderSettingsEntry>

export interface TestKeyResult {
  ok: boolean
  error?: string
}

/**
 * A real piece of evidence (a git diff, a file's content, a past Coding/
 * Workflow run) attached to a Vergleichen/Team/Council request. Folded
 * into the plain-string prompt right before it reaches council-core (see
 * ipc.ts's withAttachments) - council-core's AIProvider/CouncilRequest
 * contract stays untouched (content is and remains a plain string), so
 * this is purely a renderer/IPC-layer concern, not a new capability
 * council-core needs to know about.
 */
export interface AttachedArtifact {
  label: string
  text: string
}

export interface ParallelRunRequestDto {
  prompt: string
  providers: ProviderId[]
  attachments?: AttachedArtifact[]
}

export interface TeamStepDto {
  provider: ProviderId
  roleInstruction: string
}

export interface TeamRunRequestDto {
  prompt: string
  steps: TeamStepDto[]
  attachments?: AttachedArtifact[]
}

export interface CouncilRunRequestDto {
  prompt: string
  providers: ProviderId[]
  chairId: ProviderId
  attachments?: AttachedArtifact[]
}

export interface CaptureDiffResult {
  ok: boolean
  artifact?: AttachedArtifact
  error?: string
  /** True when the only reason ok is false is "nothing to attach" - not a failure, so the UI shouldn't show it as one. */
  noChanges?: boolean
}

/**
 * Independent from Council/AIProvider DTOs above on purpose - a coding
 * executor is a different kind of thing (agentic runtime with filesystem
 * access) and its wiring must not get entangled with the Council API's.
 */
export type CodingExecutorId = 'claude-code-cli' | 'openai-codex-cli' | 'google-antigravity-cli'

export const CODING_EXECUTOR_LABELS: Record<CodingExecutorId, string> = {
  'claude-code-cli': 'Claude Code',
  'openai-codex-cli': 'OpenAI Codex',
  'google-antigravity-cli': 'Gemini (Antigravity)'
}

export interface CodingDetectResult {
  installed: boolean
  version?: string
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown'
}

export const PERMISSION_TIER_LABELS: Record<PermissionTier, string> = {
  'read-only': 'Nur lesen',
  'read-write': 'Lesen + Schreiben',
  full: 'Lesen + Schreiben + Shell'
}

export interface StartCodingTaskDto {
  executorId: CodingExecutorId
  prompt: string
  workingDirectory: string
  permissionTier: PermissionTier
}

export interface CodingEventEnvelope {
  executorId: CodingExecutorId
  taskId: string
  event: CodingExecutorEvent
}

/**
 * Both roles accept any of the three executors - the user assigns them
 * freely (e.g. Codex implements + Gemini reviews, or any other pairing),
 * nothing is hardcoded to a specific tool.
 */
export interface RunWorkflowDto {
  implementerId: CodingExecutorId
  reviewerId: CodingExecutorId
  task: string
  workingDirectory: string
  permissionTier: PermissionTier
  pipeline?: PipelineConfig
}

export interface WorkflowEventEnvelope {
  workflowId: string
  event: WorkflowEvent
}

export interface RunWorkflowResult {
  /** Empty if setup failed (see `error`) - the workflow never started. */
  workflowId: string
  worktree?: WorktreeInfo
  error?: string
}

export interface WorktreeActionResult {
  ok: boolean
  error?: string
}

/**
 * Display-log entry for one Coding-tab task or one Workflow stage. Defined
 * here (the shared main/preload/renderer boundary) rather than in the
 * renderer, so the main-process history store can persist and return it
 * without importing renderer code.
 */
export type CodingLogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'status'; message: string; count: number }
  | { kind: 'command'; command: string; exitCode?: number }
  | { kind: 'file_change'; path: string; changeType: string }
  | { kind: 'warning'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; summary: string; sessionId?: string }

/**
 * Persisted record of one completed Coding-tab task or Workflow run. Exists
 * because re-running the same expensive analysis prompt just to get back to
 * a plan point you already saw (e.g. "point 2 of the 7 suggestions") burns
 * real subscription usage on every executor - the full log is kept so a
 * past run can be reopened and its plan re-used without calling the model
 * again.
 */
export interface CodingRunRecord {
  id: string
  kind: 'coding'
  executorId: CodingExecutorId
  workingDirectory: string
  permissionTier?: PermissionTier
  prompt: string
  logs: CodingLogEntry[]
  sessionId?: string
  startedAt: number
  finishedAt: number
}

export interface WorkflowRunRecord {
  id: string
  kind: 'workflow'
  /**
   * The orchestrator's own workflowId (distinct from `id`, this record's
   * history-store id) - needed to look up the still-tracked worktree in
   * the main process after reopening this record from history, since
   * merge/discard are keyed by workflowId, not by history record id.
   */
  workflowId: string
  implementerId: CodingExecutorId
  reviewerId: CodingExecutorId
  /** The real project directory the user picked - the run itself happened in `worktree.path`, not here. */
  workingDirectory: string
  permissionTier: PermissionTier
  task: string
  pipeline?: PipelineConfig
  stages: Record<WorkflowStage, CodingLogEntry[]>
  diffs: Partial<Record<WorkflowStage, GitDiffResult>>
  finalResult: { success: boolean; reason?: string; noChanges?: boolean }
  /**
   * Present only if isolation was set up (workingDirectory was a git repo).
   * Allows legacy runs to restore their worktree association after restart.
   * New runs also persist it independently before execution starts.
   */
  worktree?: WorktreeInfo
  startedAt: number
  finishedAt: number
}

export type HistoryRunRecord = CodingRunRecord | WorkflowRunRecord

export interface HistoryListEntry {
  id: string
  kind: 'coding' | 'workflow'
  workingDirectory: string
  summary: string
  outcome: 'ok' | 'error' | 'noChanges'
  startedAt: number
  finishedAt: number
}

/**
 * A saved working-directory shortcut. Exists purely to stop retyping/
 * re-picking the same project path in the Coding and Workflow tabs every
 * time - deliberately just a name + path (+ optional default permission
 * tier), not a bigger per-project config (build/test commands, rules).
 * Shared across both tabs; executor selection stays per-tab/per-task since
 * that varies more than the directory does.
 */
export interface ProjectProfile {
  id: string
  name: string
  workingDirectory: string
  defaultPermissionTier?: PermissionTier
  createdAt: number
  lastUsedAt: number
}

/**
 * A standing fact/rule about the user's own business, not the app itself.
 * Content is entirely the user's to enter - this is infrastructure
 * only, never seeded with invented facts. Optionally folded into
 * Vergleichen/Team/Council prompts (see company-truth-format.ts's
 * withCompanyTruth) so every mode can be grounded in the same facts and a
 * model can't casually contradict them (e.g. suggesting an App Store
 * listing for a product that has no native iOS app).
 */
export type CompanyFactCategory = 'PRODUCT_FACT' | 'TECH_FACT' | 'MARKETING_RULE' | 'LEGAL_RULE' | 'DECISION'

export const COMPANY_FACT_CATEGORY_LABELS: Record<CompanyFactCategory, string> = {
  PRODUCT_FACT: 'Produktfakt',
  TECH_FACT: 'Technik-Fakt',
  MARKETING_RULE: 'Marketing-Regel',
  LEGAL_RULE: 'Rechtliche Regel',
  DECISION: 'Entscheidung'
}

export interface CompanyFact {
  id: string
  category: CompanyFactCategory
  text: string
  createdAt: number
}

/**
 * Omit projectId to start a brand-new project (a fresh id is generated).
 * Pass projectId + userNote to send an existing project back to the council
 * for a revision - the new version's supersedesVersion is set automatically
 * from the project's current latest version.
 */
export interface GenerateSpecRequestDto {
  planningProfile?: 'simple' | 'standard'
  deliberation?: 'compact' | 'full'
  projectId?: string
  goal: string
  providers: ProviderId[]
  chairId: ProviderId
  userNote?: string
}

export type ProjectSpecGeneratedEnvelope =
  | { projectId: string; ok: true; spec: ProjectSpecification }
  | { projectId: string; ok: false; error: string; rawText: string }

export interface GenerateTaskGraphRequestDto {
  planningProfile?: 'simple' | 'standard'
  deliberation?: 'compact' | 'full'
  projectId: string
  specVersion: number
  providers: ProviderId[]
  chairId: ProviderId
}

export type TaskGraphGeneratedEnvelope =
  | { projectId: string; ok: true; snapshot: TaskGraphSnapshot }
  | { projectId: string; ok: false; error: string; rawText: string }

export interface SetTaskGraphWorkingDirectoryDto {
  projectId: string
  workingDirectory: string
}

/** Same shape, but settable from project creation time onward (project-directory-store.ts) - well before a taskgraph exists. */
export interface SetProjectWorkingDirectoryDto {
  projectId: string
  workingDirectory: string
}

/**
 * Both roles accept any of the three executors, same as RunWorkflowDto -
 * no permissionTier here on purpose: the implementer always runs
 * 'read-write' inside its isolated worktree (the worktree itself is the
 * safety boundary, same reasoning already used for CouncilParticipant's
 * forced read-only tier elsewhere in this app).
 */
export interface RunTaskGraphTaskDto {
  recheckWorkspace?: boolean
  projectId: string
  taskId: string
  implementerId: CodingExecutorId
  reviewerId: CodingExecutorId
  challengerId?: CodingExecutorId
}

export interface TaskGraphRunResult {
  /** Empty if setup failed (see `error`) - the run never started. */
  workflowId: string
  worktree?: WorktreeInfo
  error?: string
}

export interface TaskGraphTaskEventEnvelope {
  projectId: string
  taskId: string
  workflowId: string
  event: WorkflowEvent
}

export interface AcceptOrDiscardTaskDto {
  projectId: string
  taskId: string
  reason?: string
}

export interface UpdateChangeRequestProposalDto {
  projectId: string
  id: string
  proposedChanges: string
  severity: ChangeRequestSeverity
}

export interface EvaluateChangeRequestDto {
  projectId: string
  id: string
  providers: ProviderId[]
  chairId: ProviderId
  proposal?: Pick<UpdateChangeRequestProposalDto, 'proposedChanges' | 'severity'>
}

export type ChangeRequestEvaluatedEnvelope =
  | { projectId: string; id: string; ok: true; recommendation: 'proceed' | 'reject'; rationale: string }
  | { projectId: string; id: string; ok: false; error: string; rawText: string }

export interface RespondPermissionRequestDto {
  projectId: string
  attemptId: string
  granted: boolean
}

export interface RespondInstallRequestDto {
  projectId: string
  attemptId: string
  decision: { approved: false } | { approved: true; command: CommandSpec }
}
