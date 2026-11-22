/**
 * `memoryUsage` session projection (design §6.10).
 *
 * A read-only, purely derived view of memory activity inside one Session. It
 * consumes the durable session event log — memory-index `user/message` sources
 * and the memory tool `tool/call` / `tool/result` pair — and never touches the
 * memory store, the model context or any statistics. The value is published to
 * the Client through `wire.view`, for the chat activity card.
 * @module dsh-memory/host/projection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { MemoryIndexSource, MemoryUsageTurn, MemoryUsageView } from '../shared/types.ts'

/** Projection key registered on `ctx.sessionProjections`. */
export const MEMORY_USAGE_KEY = 'memoryUsage'

/** Memory tool names whose calls count as memory activity. */
const MEMORY_SEARCH_TOOL = 'memory_search'
const MEMORY_WRITE_TOOL = 'memory_write'

/** Mutable projection state; plain JSON so the projection cache can checkpoint it. */
export interface MemoryUsageState {
  /** Activity by turn number (decimal string keys). */
  turns: Record<string, MemoryUsageTurn>
  totalInjected: number
  totalWritten: number
  /** Most recent `turn/start` turn, used to attribute `user/message` injections. */
  lastTurn: number
  /** `memory_write` call ids awaiting a result, mapped to their turn. */
  writeCalls: Record<string, number>
}

const turnSchema = z
  .object({
    injected: z.array(z.string()),
    written: z.array(z.string()),
    searched: z.number().int().nonnegative(),
  })
  .strict()

const stateSchema = z
  .object({
    turns: z.record(z.string(), turnSchema),
    totalInjected: z.number().int().nonnegative(),
    totalWritten: z.number().int().nonnegative(),
    lastTurn: z.number().int().nonnegative(),
    writeCalls: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()

const viewSchema = z
  .object({
    turns: z.record(z.string(), turnSchema),
    totalInjected: z.number().int().nonnegative(),
    totalWritten: z.number().int().nonnegative(),
  })
  .strict()

/** An empty per-turn activity record. */
function emptyTurn(): MemoryUsageTurn {
  return { injected: [], written: [], searched: 0 }
}

/** Read the tool result text blocks as one string, when present. */
function toolResultText(message: ToolResultMessage): string | undefined {
  const content = (message as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return parts.length === 0 ? undefined : parts.join('')
}

/** Extract the created/updated memory id from a `memory_write` result payload. */
function writtenIdOf(message: ToolResultMessage): string | undefined {
  const text = toolResultText(message)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : undefined
  } catch {
    return undefined
  }
}

/**
 * Fold one session event into the projection state.
 *
 * Returns the same state reference for events it ignores, so unchanged cells
 * cost nothing downstream. Never mutates the incoming state.
 * @param state - Current projection state.
 * @param event - Committed session event.
 * @returns The next state, or the same reference when unaffected.
 */
export function applyMemoryUsage(state: MemoryUsageState, event: SessionEvent): MemoryUsageState {
  switch (event.type) {
    case 'turn/start': {
      const turn = event.data.turn
      if (state.lastTurn === turn) return state
      return { ...state, lastTurn: turn }
    }
    case 'user/message': {
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind !== 'dsh-memory') return state
      const index = source as MemoryIndexSource
      if (!Array.isArray(index.changes)) return state
      const ids = index.changes
        .filter((change) => change.action !== 'remove')
        .map((change) => change.memoryId)
      if (ids.length === 0) return state
      const key = String(state.lastTurn)
      const current = state.turns[key] ?? emptyTurn()
      const injected = [...current.injected]
      for (const id of ids) if (!injected.includes(id)) injected.push(id)
      const added = injected.length - current.injected.length
      if (added === 0) return state
      const nextTurns = { ...state.turns, [key]: { ...current, injected } }
      const uniqueInjected = new Set<string>()
      for (const turn of Object.values(nextTurns)) {
        for (const id of turn.injected) uniqueInjected.add(id)
      }
      return {
        ...state,
        turns: nextTurns,
        totalInjected: uniqueInjected.size,
      }
    }
    case 'tool/call': {
      const { name, callId, turn } = event.data
      if (name === MEMORY_SEARCH_TOOL) {
        const key = String(turn)
        const current = state.turns[key] ?? emptyTurn()
        return {
          ...state,
          turns: { ...state.turns, [key]: { ...current, searched: current.searched + 1 } },
        }
      }
      if (name === MEMORY_WRITE_TOOL) {
        return { ...state, writeCalls: { ...state.writeCalls, [callId]: turn } }
      }
      return state
    }
    case 'tool/result': {
      const data = event.data
      const message = data.message
      const callId = message?.source?.callId
      if (callId === undefined) return state
      const writeTurn = state.writeCalls[callId]
      if (writeTurn === undefined) return state
      const writeCalls = { ...state.writeCalls }
      delete writeCalls[callId]
      if (data.error !== undefined || (message as { isError?: boolean }).isError === true) {
        return { ...state, writeCalls }
      }
      const id = writtenIdOf(message)
      if (id === undefined) return { ...state, writeCalls }
      const key = String(writeTurn)
      const current = state.turns[key] ?? emptyTurn()
      if (current.written.includes(id)) return { ...state, writeCalls }
      return {
        ...state,
        turns: { ...state.turns, [key]: { ...current, written: [...current.written, id] } },
        totalWritten: state.totalWritten + 1,
        writeCalls,
      }
    }
    default:
      return state
  }
}

/** Cache of stable `view()` objects, one per state reference. */
const viewCache = new WeakMap<MemoryUsageState, MemoryUsageView>()

/**
 * Return a stable Client view for one state.
 *
 * The same state reference yields the same view object, so the framework only
 * republishes when activity actually changed.
 * @param state - Current projection state.
 * @returns The wire value (turns plus totals, never the internal fields).
 */
export function viewMemoryUsage(state: MemoryUsageState): MemoryUsageView {
  const cached = viewCache.get(state)
  if (cached !== undefined) return cached
  const value: MemoryUsageView = {
    turns: state.turns,
    totalInjected: state.totalInjected,
    totalWritten: state.totalWritten,
  }
  viewCache.set(state, value)
  return value
}

/** The `ctx.sessionProjections` definition for {@link MEMORY_USAGE_KEY}. */
export const memoryUsageDefinition = {
  key: MEMORY_USAGE_KEY,
  stateVersion: 1,
  stateSchema,
  init: (): MemoryUsageState => ({
    turns: {},
    totalInjected: 0,
    totalWritten: 0,
    lastTurn: 0,
    writeCalls: {},
  }),
  apply: applyMemoryUsage,
  wire: {
    viewSchema,
    view: viewMemoryUsage,
  },
} as const

/** Structural face of the live `ctx.sessionProjections` service. */
interface SessionProjectionsFace {
  register?: (definition: unknown) => unknown
}

/**
 * Register the `memoryUsage` projection on the plugin context.
 *
 * The service is optional: profiles without `ctx.sessionProjections` simply
 * skip the UI projection, and the memory service still starts. Registration is
 * owned by the plugin fiber, so the service unregisters it on dispose — no
 * manual disposer is needed.
 * @param ctx - Plugin context.
 */
export function registerMemoryUsageProjection(ctx: Context): void {
  const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.(
    'sessionProjections',
  ) as SessionProjectionsFace | undefined
  if (service?.register === undefined) return
  try {
    const result = service.register(memoryUsageDefinition)
    if (
      result !== null &&
      typeof result === 'object' &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      void (result as Promise<unknown>).catch((error: unknown) => {
        warn(ctx, error)
      })
    }
  } catch (error) {
    warn(ctx, error)
  }
}

/** Log a projection registration failure without breaking service startup. */
function warn(ctx: Context, error: unknown): void {
  const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger
  logger?.warn?.(`dsh-memory: memoryUsage projection registration failed: ${String(error)}`)
}
