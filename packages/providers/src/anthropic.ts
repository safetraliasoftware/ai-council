import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import type {
  AIProvider,
  CouncilError,
  CouncilRequest,
  GenerateOptions,
  ProviderCapabilities,
  ProviderEvent
} from '@ai-council/shared'
import { requestText, toAnthropicUserContent, UnsupportedInputFileError } from './input-files'

export interface AnthropicProviderConfig {
  apiKey: string
  model: string
}

function mapError(err: unknown): CouncilError {
  const base = { providerId: 'anthropic' as const, message: err instanceof Error ? err.message : String(err) }
  if (err instanceof Anthropic.AuthenticationError) {
    return { ...base, code: 'auth', retryable: false }
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { ...base, code: 'rate_limit', retryable: true }
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { ...base, code: 'invalid_request', retryable: false }
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { ...base, code: 'network', retryable: true }
  }
  return { ...base, code: 'unknown', retryable: false }
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const
  private client: Anthropic

  constructor(private config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey })
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
      const userContent = files.length > 0 ? await toAnthropicUserContent(text, files) : text
      const stream = this.client.messages.stream(
        {
          model: this.config.model,
          max_tokens: 8192,
          // Claude Opus 5 runs adaptive thinking by default when `thinking`
          // is omitted (see skill docs) - the installed SDK's published
          // types don't yet model `{type: "adaptive"}` explicitly, so this
          // avoids fighting a type-definition lag rather than the live API.
          ...(request.systemInstructions ? { system: request.systemInstructions } : {}),
          messages: [{ role: 'user', content: userContent }]
        },
        { signal: options?.signal }
      )

      let fullText = ''
      for await (const event of stream) {
        if (options?.signal?.aborted) break
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text
          yield { type: 'text_delta', text: event.delta.text }
        }
      }
      if (options?.signal?.aborted) return

      const final = await stream.finalMessage()
      if (final.stop_reason === 'refusal') {
        yield {
          type: 'error',
          error: {
            providerId: 'anthropic',
            code: 'refused',
            message: 'Claude hat die Anfrage aus Sicherheitsgründen abgelehnt.',
            retryable: false
          }
        }
        return
      }
      if (final.usage) {
        yield {
          type: 'usage',
          usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens }
        }
      }
      yield { type: 'done', result: { text: fullText } }
    } catch (err) {
      if (err instanceof UnsupportedInputFileError) {
        yield { type: 'error', error: { providerId: 'anthropic', code: 'invalid_request', message: err.message, retryable: false } }
        return
      }
      yield { type: 'error', error: mapError(err) }
    }
  }
}

export async function testAnthropicKey(apiKey: string, model: string): Promise<void> {
  const client = new Anthropic({ apiKey })
  await client.messages.create({
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Antworte nur mit "ok".' }]
  })
}
