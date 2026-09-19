import OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import type {
  AIProvider,
  CouncilError,
  CouncilRequest,
  GenerateOptions,
  ProviderCapabilities,
  ProviderEvent
} from '@ai-council/shared'
import { requestText, toOpenAIUserContent, UnsupportedInputFileError } from './input-files'

export interface OpenAIProviderConfig {
  apiKey: string
  model: string
}

function mapError(err: unknown): CouncilError {
  const base = { providerId: 'openai' as const, message: err instanceof Error ? err.message : String(err) }
  if (err instanceof OpenAI.AuthenticationError) {
    return { ...base, code: 'auth', retryable: false }
  }
  if (err instanceof OpenAI.RateLimitError) {
    return { ...base, code: 'rate_limit', retryable: true }
  }
  if (err instanceof OpenAI.BadRequestError) {
    return { ...base, code: 'invalid_request', retryable: false }
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return { ...base, code: 'network', retryable: true }
  }
  return { ...base, code: 'unknown', retryable: false }
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const
  private client: OpenAI

  constructor(private config: OpenAIProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey })
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
      const userContent = files.length > 0 ? await toOpenAIUserContent(text, files) : text
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            ...(request.systemInstructions
              ? [{ role: 'system' as const, content: request.systemInstructions }]
              : []),
            { role: 'user' as const, content: userContent }
          ]
        },
        { signal: options?.signal }
      )

      let fullText = ''
      for await (const chunk of stream) {
        if (options?.signal?.aborted) break
        const delta = chunk.choices[0]?.delta?.content
        if (delta) {
          fullText += delta
          yield { type: 'text_delta', text: delta }
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens
            }
          }
        }
      }
      if (options?.signal?.aborted) return

      yield { type: 'done', result: { text: fullText } }
    } catch (err) {
      if (err instanceof UnsupportedInputFileError) {
        yield { type: 'error', error: { providerId: 'openai', code: 'invalid_request', message: err.message, retryable: false } }
        return
      }
      yield { type: 'error', error: mapError(err) }
    }
  }
}

export async function testOpenAIKey(apiKey: string, model: string): Promise<void> {
  const client = new OpenAI({ apiKey })
  await client.chat.completions.create({
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Antworte nur mit "ok".' }]
  })
}
