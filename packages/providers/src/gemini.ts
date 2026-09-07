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
    return { streaming: true, tools: false, vision: false }
  }

  async *generate(request: CouncilRequest, options?: GenerateOptions): AsyncIterable<ProviderEvent> {
    const runId = randomUUID()
    yield { type: 'start', runId }

    try {
      // NOTE (known open point): the @google/genai SDK's per-call AbortSignal
      // wiring isn't confirmed against docs yet, so true request cancellation
      // isn't implemented for Gemini - stream consumption stops locally below.
      const stream = await this.client.models.generateContentStream({
        model: this.config.model,
        contents: request.messages.map((m) => m.content).join('\n\n'),
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
