import type { ProviderId } from '@ai-council/shared'
import type { CodingExecutorEvent, PermissionTier } from '@ai-council/coding'

export interface ProviderSettingsEntry {
  hasKey: boolean
  model: string
}

export type SettingsState = Record<ProviderId, ProviderSettingsEntry>

export interface TestKeyResult {
  ok: boolean
  error?: string
}

export interface ParallelRunRequestDto {
  prompt: string
  providers: ProviderId[]
}

export interface TeamStepDto {
  provider: ProviderId
  roleInstruction: string
}

export interface TeamRunRequestDto {
  prompt: string
  steps: TeamStepDto[]
}

export interface CouncilRunRequestDto {
  prompt: string
  providers: ProviderId[]
  chairId: ProviderId
}

/**
 * Independent from Council/AIProvider DTOs above on purpose - a coding
 * executor is a different kind of thing (agentic runtime with filesystem
 * access) and its wiring must not get entangled with the Council API's.
 */
export type CodingExecutorId = 'claude-code-cli' | 'openai-codex-cli'

export const CODING_EXECUTOR_LABELS: Record<CodingExecutorId, string> = {
  'claude-code-cli': 'Claude Code',
  'openai-codex-cli': 'OpenAI Codex'
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
