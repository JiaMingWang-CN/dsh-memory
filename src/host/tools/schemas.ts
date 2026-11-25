/**
 * Shared structured output schemas and JSON text renderer for memory model tools.
 * @module memloom/host/tools/schemas
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Allowed memory types exposed by model tools. */
export const MEMORY_TYPES = ['lesson', 'worklog', 'wiki', 'preference'] as const

/** Allowed memory statuses returned by model tools. */
export const MEMORY_STATUSES = ['active', 'pending', 'archived'] as const

/** Strict object schema for a serialized `MemoryScope` union. */
export const MEMORY_SCOPE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'global', required: true },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'workspace', required: true },
        key: { type: 'string', required: true },
        root: { type: 'string', required: true },
      },
      additionalProperties: false,
    },
  ],
} as const satisfies ValueSchemaSpec

/** Strict object schema shared by `memory_dream` and `memory_organize`. */
export const DREAM_QUEUE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    dreamId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      required: true,
    },
    status: {
      type: 'string',
      enum: ['queued', 'error'],
      required: true,
    },
    reason: { type: 'string' },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** Render any structured tool output value as a single JSON text block. */
export function renderJsonOutput(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}
