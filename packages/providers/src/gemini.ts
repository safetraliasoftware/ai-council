import { GoogleGenAI } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type {
  AIProvider,
  CouncilError,
  CouncilRequest,
  GenerateOptions,
  ProviderCapabilities,
  ProviderEvent
} from '@ai-council/shared'
import { requestText, toGeminiParts, UnsupportedInputFileError } from './input-files'

export interface GeminiProviderConfig {
  apiKey: string
  model: string
}

interface GoogleApiErrorShape {
  status?: number
  message?: string
}

function mapError(err: unknown): CouncilError {
  const message = err instanceof Error ? err.message : String(err)
  const status = (err as GoogleApiErrorShape)?.status
  let code: CouncilError['code'] = 'unknown'
  let retryable = false
  if (status === 401 || status === 403) {
    code = 'auth'
  } else if (status === 429) {
    code = 'rate_limit'
    retryable = true
  } else if (status === 400) {
    code = 'invalid_request'
  } else if (status && status >= 500) {
    code = 'network'
    retryable = true
  }
  return { providerId: 'gemini', code, message, retryable }
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const
  private client: GoogleGenAI

  constructor(private config: GeminiProviderConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey })
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, tools: false, vision: true }
  }

  async *generate(request: CouncilRequest, options?: GenerateOptions): AsyncIterable<ProviderEvent> {
    const runId = randomUUID()
    yield { type: 'start', runId }

    try {
      const files = request.inputFiles ?? []
      const text = requestText(request.messages)
      const contents = files.length > 0 ? await toGeminiParts(text, files) : text
      // NOTE (known open point): the @google/genai SDK's per-call AbortSignal
      // wiring isn't confirmed against docs yet, so true request cancellation
      // isn't implemented for Gemini - stream consumption stops locally below.
      const stream = await this.client.models.generateContentStream({
        model: this.config.model,
        contents,
        ...(request.systemInstructions
          ? { config: { systemInstruction: request.systemInstructions } }
          : {})
      })

      let fullText = ''
      for await (const chunk of stream) {
        if (options?.signal?.aborted) break
        const delta = chunk.text
        if (delta) {
          fullText += delta
          yield { type: 'text_delta', text: delta }
        }
        const usageMeta = chunk.usageMetadata
        if (usageMeta) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usageMeta.promptTokenCount,
              outputTokens: usageMeta.candidatesTokenCount
            }
          }
        }
      }
      if (options?.signal?.aborted) return

      yield { type: 'done', result: { text: fullText } }
    } catch (err) {
      if (err instanceof UnsupportedInputFileError) {
        yield { type: 'error', error: { providerId: 'gemini', code: 'invalid_request', message: err.message, retryable: false } }
        return
      }
      yield { type: 'error', error: mapError(err) }
    }
  }
}

export async function testGeminiKey(apiKey: string, model: string): Promise<void> {
  const client = new GoogleGenAI({ apiKey })
  await client.models.generateContent({
    model,
    contents: 'Antworte nur mit "ok".'
  })
}
