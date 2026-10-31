import { Schema } from 'effect'

export type Counts = { input?: number; output?: number; cached?: number; cacheCreation?: number; reasoning?: number }
export interface RuntimeTelemetry {
  span<T>(
    name: string,
    attributes: Record<string, unknown>,
    task: (annotate: (attributes: Record<string, unknown>) => void) => Promise<T>,
  ): Promise<T>
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))
const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** Reads only explicitly reported token fields from provider stream events. */
export function providerUsage(api: string, event: unknown): Counts {
  const value = record(event)
  if (!value) return {}
  if (api === 'anthropic-messages') {
    const usage = record(value.usage) ?? record(record(value.message)?.usage)
    return {
      ...(count(usage?.input_tokens) === undefined ? {} : { input: count(usage?.input_tokens)! }),
      ...(count(usage?.output_tokens) === undefined ? {} : { output: count(usage?.output_tokens)! }),
      ...(count(usage?.cache_read_input_tokens) === undefined
        ? {}
        : { cached: count(usage?.cache_read_input_tokens)! }),
      ...(count(usage?.cache_creation_input_tokens) === undefined
        ? {}
        : { cacheCreation: count(usage?.cache_creation_input_tokens)! }),
    }
  }
  if (api === 'openai-completions') {
    const choice = Array.isArray(value.choices) ? record(value.choices[0]) : undefined
    const usage = record(value.usage) ?? record(choice?.usage)
    const details = record(usage?.prompt_tokens_details)
    const outputDetails = record(usage?.completion_tokens_details)
    const cached = count(details?.cached_tokens) ?? count(usage?.prompt_cache_hit_tokens) ?? count(usage?.cached_tokens)
    return {
      ...(count(usage?.prompt_tokens) === undefined ? {} : { input: count(usage?.prompt_tokens)! }),
      ...(count(usage?.completion_tokens) === undefined ? {} : { output: count(usage?.completion_tokens)! }),
      ...(cached === undefined ? {} : { cached }),
      ...(count(outputDetails?.reasoning_tokens) === undefined
        ? {}
        : { reasoning: count(outputDetails?.reasoning_tokens)! }),
    }
  }
  if (['openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(api)) {
    const usage = record(record(value.response)?.usage)
    const cached = count(record(usage?.input_tokens_details)?.cached_tokens)
    const reasoning = count(record(usage?.output_tokens_details)?.reasoning_tokens)
    return {
      ...(count(usage?.input_tokens) === undefined ? {} : { input: count(usage?.input_tokens)! }),
      ...(count(usage?.output_tokens) === undefined ? {} : { output: count(usage?.output_tokens)! }),
      ...(cached === undefined ? {} : { cached }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }
  if (api === 'google-generative-ai' || api === 'google-vertex') {
    const usage = record(value.usageMetadata)
    const input = count(usage?.promptTokenCount)
    const output = count(usage?.candidatesTokenCount)
    const thinking = count(usage?.thoughtsTokenCount)
    const cached = count(usage?.cachedContentTokenCount)
    return {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output: output + (thinking ?? 0) }),
      ...(cached === undefined ? {} : { cached }),
      ...(thinking === undefined ? {} : { reasoning: thinking }),
    }
  }
  return {}
}
