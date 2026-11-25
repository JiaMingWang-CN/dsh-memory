/**
 * DSH-specific LLM message augmentation for memory index injection.
 * @module dsh-memory/host/index-types
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryIndexSource } from '../shared/types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Durable memory index injection produced by the dsh-memory plugin. */
    'dsh-memory': MemoryIndexSource
  }
}

/** A durable user message carrying a {@link MemoryIndexSource}. */
export type MemoryIndexMessage = UserMessage & { readonly source: MemoryIndexSource }
