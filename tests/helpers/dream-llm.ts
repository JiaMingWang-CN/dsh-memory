/**
 * Scripted LLM stand-in for the dreamer tests: yields one text delta per
 * configured response and records every `GenerateOptions` it received.
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export interface ScriptedLlm {
  calls: GenerateOptions[]
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export function scriptedLlm(responses: readonly string[]): ScriptedLlm {
  const calls: GenerateOptions[] = []
  let index = 0
  return {
    calls,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const text = responses[Math.min(index, responses.length - 1)] ?? ''
      index += 1
      async function* generate(): AsyncGenerator<StreamChunk> {
        if (text.length > 0) yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return generate()
    },
  }
}

/** A dream JSON body referencing the given episode ids. */
export function dreamJson(
  episodeIds: readonly string[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    memories: [
      {
        type: 'lesson',
        title: 'Always run typecheck first',
        body: 'Run typecheck before building.',
        confidence: 0.8,
        importance: 0.6,
        sourceEpisodeIds: [...episodeIds],
        ...overrides,
      },
    ],
    wikiUpdates: [],
  })
}
