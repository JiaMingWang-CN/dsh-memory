/**
 * Shared memory data contract.
 *
 * These are the canonical record shapes used by both the Host service and
 * (later) the Client Remote surface. They are declared once here as zod
 * schemas so validation and TypeScript types cannot drift, and the `memory`
 * domain is built directly from these schemas.
 * @module dsh-memory/shared/types
 */
import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * Branded identifiers
 * ------------------------------------------------------------------ */

declare const idBrand: unique symbol

/** A string identifier branded with the entity it belongs to. */
export type BrandedId<B extends string> = string & { readonly [idBrand]: B }

export type MemoryId = BrandedId<'MemoryId'>
export type EpisodeId = BrandedId<'EpisodeId'>
export type DreamId = BrandedId<'DreamId'>
export type AuditId = BrandedId<'AuditId'>
export type OperationId = BrandedId<'OperationId'>

const brandedString = <B extends string>(value: string): BrandedId<B> => value as BrandedId<B>

export const MemoryId = (value: string): MemoryId => brandedString<'MemoryId'>(value)
export const EpisodeId = (value: string): EpisodeId => brandedString<'EpisodeId'>(value)
export const DreamId = (value: string): DreamId => brandedString<'DreamId'>(value)
export const AuditId = (value: string): AuditId => brandedString<'AuditId'>(value)
export const OperationId = (value: string): OperationId => brandedString<'OperationId'>(value)

export const newMemoryId = (): MemoryId => MemoryId(globalThis.crypto.randomUUID())
export const newEpisodeId = (): EpisodeId => EpisodeId(globalThis.crypto.randomUUID())
export const newDreamId = (): DreamId => DreamId(globalThis.crypto.randomUUID())
export const newAuditId = (): AuditId => AuditId(globalThis.crypto.randomUUID())
export const newOperationId = (): OperationId => OperationId(globalThis.crypto.randomUUID())

const memoryIdSchema = z
  .string()
  .min(1)
  .transform((value): MemoryId => MemoryId(value))
const episodeIdSchema = z
  .string()
  .min(1)
  .transform((value): EpisodeId => EpisodeId(value))
const dreamIdSchema = z
  .string()
  .min(1)
  .transform((value): DreamId => DreamId(value))
const auditIdSchema = z
  .string()
  .min(1)
  .transform((value): AuditId => AuditId(value))
const operationIdSchema = z
  .string()
  .min(1)
  .transform((value): OperationId => OperationId(value))

/* ------------------------------------------------------------------ *
 * Literal unions
 * ------------------------------------------------------------------ */

export const memoryTypeSchema = z.enum(['lesson', 'worklog', 'wiki', 'preference'])
export type MemoryType = z.infer<typeof memoryTypeSchema>

export const memoryStatusSchema = z.enum(['active', 'pending', 'archived'])
export type MemoryStatus = z.infer<typeof memoryStatusSchema>

export const memoryOwnershipSchema = z.enum(['user', 'derived'])
export type MemoryOwnership = z.infer<typeof memoryOwnershipSchema>

export const memoryOriginSchema = z.enum(['user', 'model', 'dream', 'import', 'system'])
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>

export const worklogKindSchema = z.enum(['turn', 'daily'])
export type WorklogKind = z.infer<typeof worklogKindSchema>

export const episodeKindSchema = z.enum([
  'turn',
  'tool-failure',
  'tool-recovery',
  'user-correction',
  'explicit',
  'session-error',
])
export type EpisodeKind = z.infer<typeof episodeKindSchema>

export const episodeStatusSchema = z.enum([
  'new',
  'processing',
  'processed',
  'failed-retryable',
  'skipped',
])
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>

export const dreamTriggerSchema = z.enum(['auto', 'manual', 'rebuild', 'organize'])
export type DreamTrigger = z.infer<typeof dreamTriggerSchema>

export const dreamStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
export type DreamStatus = z.infer<typeof dreamStatusSchema>

export const auditActionSchema = z.enum([
  'create',
  'update',
  'archive',
  'restore',
  'delete',
  'accept',
  'reject',
  'dream-commit',
  'dream-undo',
  'rebuild',
  'import',
  'purge',
])
export type AuditAction = z.infer<typeof auditActionSchema>

export const auditActorSchema = z.enum(['user', 'model', 'dream', 'system'])
export type AuditActor = z.infer<typeof auditActorSchema>

export const auditStatusSchema = z.enum(['applied', 'undone'])
export type AuditStatus = z.infer<typeof auditStatusSchema>

export const operationKindSchema = z.enum([
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  'memory.accept',
  'memory.reject',
  'dream.run',
  'dream.undo',
  'rebuild',
  'import',
  'purge',
])
export type OperationKind = z.infer<typeof operationKindSchema>

export const operationStatusSchema = z.enum(['planned', 'applying', 'committed', 'failed'])
export type OperationStatus = z.infer<typeof operationStatusSchema>

/* ------------------------------------------------------------------ *
 * Scope and source references
 * ------------------------------------------------------------------ */

export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z
    .object({
      kind: z.literal('workspace'),
      key: z.string().min(1),
      root: z.string().min(1),
    })
    .strict(),
])
export type MemoryScope = z.infer<typeof memoryScopeSchema>

export const memorySourceRefSchema = z
  .object({
    sessionId: z.string().min(1),
    eventSeq: z.number().int().nonnegative().optional(),
    turn: z.number().int().nonnegative().optional(),
    quote: z.string().optional(),
  })
  .strict()
export type MemorySourceRef = z.infer<typeof memorySourceRefSchema>

/* ------------------------------------------------------------------ *
 * Memory record
 * ------------------------------------------------------------------ */

export const memoryRecordSchema = z
  .object({
    id: memoryIdSchema,
    type: memoryTypeSchema,
    worklogKind: worklogKindSchema.optional(),
    scope: memoryScopeSchema,
    origin: memoryOriginSchema,
    ownership: memoryOwnershipSchema,
    pinned: z.boolean(),
    title: z.string().min(1),
    body: z.string(),
    tags: z.array(z.string()),
    status: memoryStatusSchema,
    confidence: z.number().min(0).max(1),
    importance: z.number().min(0).max(1),
    contentRevision: z.number().int().min(1),
    statsRevision: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    lastMatchedAt: z.string().min(1).optional(),
    matchCount: z.number().int().nonnegative(),
    lastUsedAt: z.string().min(1).optional(),
    useCount: z.number().int().nonnegative(),
    sourceRefs: z.array(memorySourceRefSchema),
    sourceEpisodeIds: z.array(z.string()),
    supersedes: z.array(z.string()),
    proposalKey: z.string().min(1).optional(),
    reviewedByUserAt: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
    contentHash: z.string().min(1),
  })
  .strict()
  .superRefine((record, context) => {
    // An organize proposal replaces existing memories, so `supersedes` is a
    // legitimate source even when no session/episode is attached.
    if (
      record.ownership === 'derived' &&
      record.sourceRefs.length === 0 &&
      record.sourceEpisodeIds.length === 0 &&
      record.supersedes.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRefs'],
        message:
          'a derived memory requires a source reference, source episode or superseded memory',
      })
    }
  })
export type MemoryRecord = z.infer<typeof memoryRecordSchema>

/* ------------------------------------------------------------------ *
 * Episode record
 * ------------------------------------------------------------------ */

export const episodeRecordSchema = z
  .object({
    id: episodeIdSchema,
    sessionId: z.string().min(1),
    workspaceKey: z.string().min(1),
    workspaceRoot: z.string().min(1),
    kind: episodeKindSchema,
    status: episodeStatusSchema,
    attempts: z.number().int().nonnegative(),
    lastError: z.string().optional(),
    turn: z.number().int().nonnegative(),
    sourceSeqs: z.array(z.number().int().nonnegative()),
    prompt: z.string().optional(),
    assistantFinal: z.string().optional(),
    toolName: z.string().optional(),
    toolError: z.string().optional(),
    files: z.array(z.string()),
    correctionText: z.string().optional(),
    outcome: z.string().optional(),
    /** Structured failure code from a failed turn, when one was reported. */
    failureCode: z.string().optional(),
    /** Redacted, length-bounded failure message from a failed turn. */
    failureMessage: z.string().optional(),
    createdAt: z.string().min(1),
    processedAt: z.string().min(1).optional(),
    dreamId: z.string().min(1).optional(),
  })
  .strict()
export type EpisodeRecord = z.infer<typeof episodeRecordSchema>

/* ------------------------------------------------------------------ *
 * Session cursor
 * ------------------------------------------------------------------ */

export const sessionCursorSchema = z
  .object({
    sessionId: z.string().min(1),
    workspaceKey: z.string().min(1),
    lastProcessedSeq: z.number().int().nonnegative(),
    lastProcessedAt: z.string().min(1),
  })
  .strict()
export type SessionCursor = z.infer<typeof sessionCursorSchema>

/* ------------------------------------------------------------------ *
 * Dream run
 * ------------------------------------------------------------------ */

export const dreamUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict()
export type DreamUsage = z.infer<typeof dreamUsageSchema>

export const dreamRunSchema = z
  .object({
    id: dreamIdSchema,
    trigger: dreamTriggerSchema,
    scopeKey: z.string().min(1),
    status: dreamStatusSchema,
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1).optional(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
    episodes: z.number().int().nonnegative(),
    committed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    usage: dreamUsageSchema.optional(),
    error: z.string().optional(),
  })
  .strict()
export type DreamRun = z.infer<typeof dreamRunSchema>

/* ------------------------------------------------------------------ *
 * Audit record
 * ------------------------------------------------------------------ */

export const auditRecordSchema = z
  .object({
    id: auditIdSchema,
    operationId: z.string().min(1),
    dreamId: z.string().min(1).optional(),
    action: auditActionSchema,
    memoryId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    actor: auditActorSchema,
    before: memoryRecordSchema.nullable().optional(),
    after: memoryRecordSchema.nullable().optional(),
    status: auditStatusSchema,
    undoOf: z.string().min(1).optional(),
    at: z.string().min(1),
  })
  .strict()
export type AuditRecord = z.infer<typeof auditRecordSchema>

/* ------------------------------------------------------------------ *
 * Operation record
 * ------------------------------------------------------------------ */

export const operationRecordSchema = z
  .object({
    id: operationIdSchema,
    requestId: z.string().min(1).optional(),
    requestExpiresAt: z.string().min(1).optional(),
    kind: operationKindSchema,
    status: operationStatusSchema,
    step: z.number().int().nonnegative(),
    totalSteps: z.number().int().nonnegative(),
    stepName: z.string(),
    payload: z.unknown(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    attempts: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    error: z.string().optional(),
  })
  .strict()
export type OperationRecord = z.infer<typeof operationRecordSchema>

/* ------------------------------------------------------------------ *
 * Index injection source (design §6.7)
 * ------------------------------------------------------------------ */

export type MemoryIndexChange =
  | { action: 'add' | 'replace'; memoryId: string; contentRevision: number; digest: string }
  | { action: 'remove'; memoryId: string; contentRevision: number }

export interface MemoryIndexSource {
  kind: 'dsh-memory'
  form: 'memory-index'
  mode: 'baseline' | 'delta' | 'reset'
  protocolVersion: 1
  baselineId: string
  scopeKey: string
  changes: MemoryIndexChange[]
  invalidations: { memoryId: string; contentRevision: number }[]
  /** UTF-8 bytes this delta adds to its baseline cycle (deltas only). */
  refreshBytes?: number
  /** ISO timestamp when this delta was admitted, for interval recovery. */
  refreshedAt?: string
}

/* ------------------------------------------------------------------ *
 * Memory usage projection (design §6.10, UI only)
 * ------------------------------------------------------------------ */

/** Per-turn memory activity counts surfaced to the chat card. */
export interface MemoryUsageTurn {
  /** Memory ids injected into the model context for this turn. */
  injected: string[]
  /** Memory ids written by a successful `memory_write` call in this turn. */
  written: string[]
  /** Number of `memory_search` calls in this turn. */
  searched: number
}

/** Read-only `memoryUsage` projection value published to the Client. */
export interface MemoryUsageView {
  /** Activity by turn number (decimal string keys), in insertion order. */
  turns: Record<string, MemoryUsageTurn>
  /** Total unique memories injected across every turn. */
  totalInjected: number
  /** Total memories written across every turn. */
  totalWritten: number
}
