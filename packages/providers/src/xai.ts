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
import { requestText, toXaiResponseInput, UnsupportedInputFileError } from './input-files'

// xAI's Grok API is deliberately OpenAI-chat-completions-compatible - the
// official xAI docs show the `openai` SDK itself pointed at this base URL,
// so this reuses that SDK instead of adding a separate xAI-specific
// dependency for what is otherwise an identical request/response shape.
const XAI_BASE_URL = 'https://api.x.ai/v1'

export interface XAIProviderConfig {
  apiKey: string
  model: string
}

function mapError(err: unknown): CouncilError {
  const base = { providerId: 'xai' as const, message: err instanceof Error ? err.message : String(err) }
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

export class XAIProvider implements AIProvider {
  readonly id = 'xai' as const
  private client: OpenAI

  constructor(private config: XAIProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: XAI_BASE_URL })
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, tools: false, vision: true }
  }

  async *generate(request: CouncilRequest, options?: GenerateOptions): AsyncIterable<ProviderEvent> {
    const runId = randomUUID()
    yield { type: 'start', runId }

    try {
      const files = request.inputFiles ?? []
      if (files.length > 0) {
        yield* this.generateWithFiles(request, files, options)
        return
      }

      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            ...(request.systemInstructions
              ? [{ role: 'system' as const, content: request.systemInstructions }]
              : []),
            ...request.messages.map((m) => ({ role: m.role, content: m.content }))
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
        yield { type: 'error', error: { providerId: 'xai', code: 'invalid_request', message: err.message, retryable: false } }
        return
      }
      yield { type: 'error', error: mapError(err) }
    }
  }

  /**
   * xAI's documented file/image attachments go through the Responses API
   * (`input_file` / `input_image`), not chat.completions. Text-only traffic
   * stays on chat.completions above so that path is unchanged.
   */
  private async *generateWithFiles(
    request: CouncilRequest,
    files: NonNullable<CouncilRequest['inputFiles']>,
    options?: GenerateOptions
  ): AsyncIterable<ProviderEvent> {
    const content = await toXaiResponseInput(requestText(request.messages), files)
    const stream = await this.client.responses.create(
      {
        model: this.config.model,
        stream: true,
        ...(request.systemInstructions ? { instructions: request.systemInstructions } : {}),
        input: [{ role: 'user', content }]
      },
      { signal: options?.signal }
    )

    let fullText = ''
    for await (const event of stream) {
      if (options?.signal?.aborted) break
      if (event.type === 'response.output_text.delta' && event.delta) {
        fullText += event.delta
        yield { type: 'text_delta', text: event.delta }
      }
      if (event.type === 'response.completed') {
        const usage = event.response.usage
        if (usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens
            }
          }
        }
      }
    }
    if (options?.signal?.aborted) return
    yield { type: 'done', result: { text: fullText } }
  }
}

export async function testXaiKey(apiKey: string, model: string): Promise<void> {
  const client = new OpenAI({ apiKey, baseURL: XAI_BASE_URL })
  await client.chat.completions.create({
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Antworte nur mit "ok".' }]
  })
}
