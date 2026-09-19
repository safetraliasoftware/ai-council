/**
 * Provider-neutral contracts. Providers implement these; council-core depends
 * only on these types. Neither side depends on the other.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'xai'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  xai: 'Grok'
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  /** Provider-reported value; not a subscription charge or remaining quota. */
  costUsd?: number
}

export type CouncilErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'invalid_request'
  | 'network'
  | 'refused'
  | 'unknown'

export interface CouncilError {
  providerId: ProviderId
  code: CouncilErrorCode
  message: string
  retryable: boolean
}

export interface CouncilMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * A file the host attached to this request. Orchestrators must copy this
 * array onto every derived request that still refers to the original task
 * (council critique/revision/synthesis, later team steps). Providers read
 * the bytes from `path` themselves — this is a pointer, not a payload.
 */
export interface InputFile {
  filename: string
  mimeType: string
  /** Absolute filesystem path. */
  path: string
}

export interface CouncilRequest {
  systemInstructions?: string
  messages: CouncilMessage[]
  inputFiles?: InputFile[]
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  id: string
  output: unknown
  isError?: boolean
}

export interface ProviderResult {
  text: string
  usage?: Usage
}

/**
 * Event vocabulary emitted by every provider adapter. tool_request/tool_result
 * and reasoning_status are defined now (Phase 1) but not yet emitted by any
 * adapter - this lets council-core's merge/consumer code be written once and
 * not need a breaking change when tool-calling agents land later.
 */
export type ProviderEvent =
  | { type: 'start'; runId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_status'; status: string }
  | { type: 'tool_request'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; result: ProviderResult }
  | { type: 'error'; error: CouncilError }

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  /** True when generate() maps CouncilRequest.inputFiles into native image/PDF parts. */
  vision: boolean
}

export interface GenerateOptions {
  signal?: AbortSignal
}

export interface AIProvider {
  readonly id: ProviderId
  generate(request: CouncilRequest, options?: GenerateOptions): AsyncIterable<ProviderEvent>
  capabilities(): ProviderCapabilities
}

/**
 * Host-provided secret resolution. Only an Electron-main-process (or future
 * CLI/server) implementation of this may ever touch real key material -
 * council-core and providers only see already-resolved key strings passed
 * into generate() via the host, never this interface itself.
 */
export interface SecretStore {
  getKey(provider: ProviderId): string | undefined
  setKey(provider: ProviderId, key: string): void
  clearKey(provider: ProviderId): void
  hasKey(provider: ProviderId): boolean
}
