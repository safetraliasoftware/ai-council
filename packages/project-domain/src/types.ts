import type { ProviderId } from '@ai-council/shared'
import type { ExecutionTask } from '@ai-council/task-graph'
import type { CommandSpec } from './engineering'

export interface ProjectRequirement {
  id: string // "REQ-001"
  category: 'feature' | 'security' | 'compliance' | 'architecture'
  statement: string
  acceptanceCriteria: string[] // basis for later verification, kept per requirement
  priority?: 'must' | 'should' | 'could'
}

export interface OpenQuestion {
  text: string
  // UI warns clearly before "Genehmigen" if true, but never hard-blocks it -
  // the human stays the final authority, same as every other gate in this app.
  blocking: boolean
}

// 'council_generated', not 'council_approved': a synthesis run is not a
// formal approval - council-core has no approval gate. Honest naming.
export type ProjectSpecStatus = 'draft' | 'council_generated' | 'human_approved' | 'superseded' | 'rejected'

export interface ProjectSpecification {
  id: string // stable project id across all versions
  version: number
  supersedesVersion?: number
  goal: string
  requirements: ProjectRequirement[]
  nonGoals: string[]
  architectureNotes: string
  risks: string[]
  openQuestions: OpenQuestion[]
  chairId: ProviderId // actual chair of the synthesis stage (guards against council-core's silent chair fallback)
  rawSynthesisText: string
  status: ProjectSpecStatus
  createdAt: number
  updatedAt: number
}

export type ChangeRequestSeverity = 'minor' | 'architecture' | 'security' | 'compliance'
export type ChangeRequestStatus = 'pending' | 'council_approved' | 'human_approved' | 'rejected'

export interface ChangeRequest {
  id: string
  projectId: string
  reason: string // from a parsed verdict line, see Phase D
  affectedRequirementIds: string[]
  affectedTaskIds: string[]
  proposedChanges: string // free text for council review, never an auto-patch of the spec
  severity: ChangeRequestSeverity
  status: ChangeRequestStatus
  createdAt: number
  councilRationale?: string // set once a council evaluation has run (proceed/reject + why)
  councilRecommendation?: 'proceed' | 'reject' // the structured verdict alongside councilRationale's free text - status still becomes 'council_approved' either way (the human gate decides regardless), but this preserves what the council actually recommended
  resultingSpecVersion?: number // links this CR to the ProjectSpecification version generated from it
  appliedAt?: number // set once applyChangeRequest() has run - idempotency guard, never re-applied
}

export type ProjectEventType =
  | 'ExecutionStateChanged'
  | 'ExecutionAgentEvent'
  | 'SpecificationDrafted'
  | 'SpecificationCouncilGenerated'
  | 'SpecificationHumanApproved'
  | 'SpecificationRejected'
  | 'SpecificationSuperseded'
  | 'ChangeRequestOpened'
  | 'ChangeRequestProposalUpdated'
  | 'ChangeRequestCouncilEvaluated'
  | 'ChangeRequestHumanApproved'
  | 'ChangeRequestRejected'
  | 'ChangeRequestLinkedToSpec'
  | 'ChangeRequestApplied'

export interface ProjectEvent {
  eventId: string
  projectId: string
  sequence: number // monotonic per project, gapless
  schemaVersion: 1
  type: ProjectEventType
  timestamp: number
  payload: unknown
}

/**
 * Deliberately simpler persistence than ProjectSpecification: a task graph
 * is replaced wholesale on regeneration, no version-supersede chain. That
 * richness only becomes necessary once execution/invalidation (Phase C/D)
 * exist - building it now would be designing for a requirement nothing yet
 * needs.
 */
export type TaskGraphStatus = 'council_generated' | 'human_approved' | 'rejected'

export interface TaskGraphSnapshot {
  projectId: string
  specVersion: number // which ProjectSpecification version this graph was planned against
  tasks: ExecutionTask[]
  status: TaskGraphStatus
  chairId: ProviderId
  rawSynthesisText: string
  // The real filesystem directory Phase C executes tasks against (a git
  // repo the user already owns and committed at least once). Lives here,
  // not on ProjectSpecification, because it's only needed once a task graph
  // exists - and because ProjectSpecification's event-sourced log/replay is
  // already hardened and shouldn't be touched for an unrelated field.
  workingDirectory?: string
  // Best-effort default for the Prüfprofil form (see
  // packages/coding/src/workspace/detect-verification-profile.ts) - filesystem
  // manifest detection when the working directory already has one, else a
  // keyword scan of the approved spec text for greenfield projects. Never
  // auto-approved: only seeds the UI's editable form, the human still has to
  // review and click "Prüfprofil freigeben".
  suggestedCommands?: CommandSpec[]
  createdAt: number
  updatedAt: number
}
