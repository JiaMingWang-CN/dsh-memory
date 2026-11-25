/**
 * Crash-recoverable operation log.
 *
 * The storage handle has no cross-table transaction, so every multi-table change
 * runs as a persisted `operations` state machine: `begin` writes a `planned`
 * record, `apply` performs single-table writes while advancing `step`/`stepName`
 * after each durable write, and `commit` finalizes. `recover` replays interrupted
 * operations from their last persisted step using `contentRevision` checks, so a
 * user edit made after a crash is never overwritten.
 * @module memloom/core/operations
 */
import {
  AuditId,
  memoryRecordSchema,
  newOperationId,
  type AuditActor,
  type AuditRecord,
  type DreamRun,
  type EpisodeRecord,
  type MemoryRecord,
  type OperationKind,
  type OperationRecord,
  type OperationStatus,
} from '../shared/types.ts'
import type { MemoryDomainHandle } from './storage-contract.ts'

export type OperationErrorCode =
  | 'MEMORY_CONFLICT'
  | 'MEMORY_RECOVERING'
  | 'MEMORY_CAPACITY'
  | 'MEMORY_NOT_FOUND'
  | 'MEMORY_FORBIDDEN'
  | 'MEMORY_FORBIDDEN_SCOPE'
  | 'MEMORY_STOPPED'
  | 'MEMORY_INVALID_QUERY'
  | 'MEMORY_INVALID_CONTENT'
  | 'MEMORY_INVALID_CONFIG'
  | 'MEMORY_CONFIRM_REQUIRED'
  | 'MEMORY_UNAVAILABLE'

/** Stable, transportable operation error. */
export class OperationError extends Error {
  readonly code: OperationErrorCode

  constructor(code: OperationErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = 'OperationError'
  }
}

/* ------------------------------------------------------------------ *
 * Payload contracts (persisted verbatim in `operation.payload`)
 * ------------------------------------------------------------------ */

export interface CreatePayload {
  record: MemoryRecord
  actor: AuditActor
  dreamId?: string
}

export interface PatchPayload {
  before: MemoryRecord
  after: MemoryRecord
  actor: AuditActor
  action: 'update' | 'archive' | 'restore' | 'reject'
  reason?: string
  dreamId?: string
}

export interface DeletePayload {
  before: MemoryRecord
  actor: AuditActor
  /** Omit before/after snapshots from the audit record (permanent delete). */
  minimalAudit?: boolean
}

export interface AcceptPayload {
  old: MemoryRecord | null
  oldAfter: MemoryRecord | null
  newBefore: MemoryRecord
  after: MemoryRecord
  actor: 'user'
  dreamId?: string
}

export interface DreamRunPayload {
  dreamId: string
}

/**
 * Audit rows younger than this are never pruned, even above the record cap.
 * Design §3.6 keeps the recent undo window: `undoDream` reads `dream-commit`
 * audits, so pruning them would turn a reversible dream into a silent no-op.
 */
const MIN_UNDO_AUDIT_AGE_MS = 30 * 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface RecoveryOutcome {
  id: string
  kind: OperationKind
  outcome: 'committed' | 'failed'
  error?: string
}

export interface RecoveryReport {
  recoveredAt: string
  committed: number
  failed: number
  outcomes: RecoveryOutcome[]
}

export interface DreamUndoDetail {
  memoryId?: string
  reason: string
}

export interface DreamUndoReport {
  dreamId: string
  undone: number
  skipped: number
  details: DreamUndoDetail[]
}

/** Observer used by crash-injection tests; a thrown error aborts the run mid-flight. */
export interface OperationObserver {
  afterStep?: (info: { operation: OperationRecord; stepName: string }) => void | Promise<void>
}

export interface OperationRunnerOptions {
  now?: () => Date
  requestDedupeTtlMs?: number
  maxOperationRecords?: number
  maxAuditRecords?: number
  observer?: OperationObserver
}

interface Step {
  name: string
  run: () => Promise<void>
}

const ATOMIC_TWO_STEP: ReadonlySet<OperationKind> = new Set([
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.reject',
])

/** Ordered step names of one operation kind; recovery relies on this being stable. */
function stepNames(kind: OperationKind): string[] {
  if (ATOMIC_TWO_STEP.has(kind)) return ['memory', 'audit']
  switch (kind) {
    case 'memory.delete':
      return ['audit', 'memory', 'scrub']
    case 'memory.accept':
      return ['archive-old', 'activate-new', 'audit']
    case 'dream.run':
      return ['dreams', 'episodes', 'memories', 'episodes-processed', 'dreams-completed']
    default:
      return []
  }
}

/**
 * The serialized operation state machine over one open `memory` domain.
 */
export class OperationRunner {
  private readonly domain: MemoryDomainHandle
  private readonly now: () => Date
  private readonly requestDedupeTtlMs: number
  private readonly maxOperationRecords: number
  private readonly maxAuditRecords: number
  private observer: OperationObserver
  private chain: Promise<unknown> = Promise.resolve()

  constructor(domain: MemoryDomainHandle, options: OperationRunnerOptions = {}) {
    this.domain = domain
    this.now = options.now ?? (() => new Date())
    this.requestDedupeTtlMs = options.requestDedupeTtlMs ?? 86_400_000
    this.maxOperationRecords = options.maxOperationRecords ?? 10_000
    this.maxAuditRecords = options.maxAuditRecords ?? 20_000
    this.observer = options.observer ?? {}
  }

  /** Replace the crash-injection observer (test support). */
  setObserver(observer: OperationObserver): void {
    this.observer = observer
  }

  private get memories() {
    return this.domain.table('memories')
  }
  private get audit() {
    return this.domain.table('audit')
  }
  private get operations() {
    return this.domain.table('operations')
  }
  private get dreams() {
    return this.domain.table('dreams')
  }
  private get episodes() {
    return this.domain.table('episodes')
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  /** Serialize one asynchronous unit of work to keep `operations` writes ordered. */
  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(work)
    this.chain = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  /** Wait for every queued operation callback to settle (failures are already reported to callers). */
  async flush(): Promise<void> {
    await this.chain
  }

  /**
   * Find the operation holding one request identity while its dedupe window is open.
   * @param requestId - Caller request identity.
   * @returns The existing operation, or undefined.
   */
  async findRequest(requestId: string): Promise<OperationRecord | undefined> {
    return this.runExclusive(async () => this.findDeduped(requestId))
  }

  /**
   * Write a `planned` operation, or return an existing one for the same
   * `requestId` while its dedupe window is open.
   * @param kind - Operation kind.
   * @param payload - Kind-specific payload.
   * @param requestId - Optional caller-scoped request identity.
   * @returns The operation record (existing for a deduped request).
   */
  async begin(kind: OperationKind, payload: unknown, requestId?: string): Promise<OperationRecord> {
    return this.runExclusive(async () => {
      if (requestId !== undefined) {
        const existing = this.findDeduped(requestId)
        if (existing !== undefined) return existing
      }
      const names = stepNames(kind)
      const { before, after } = summarize(payload)
      const createdAt = this.nowIso()
      const record: OperationRecord = {
        id: newOperationId(),
        kind,
        status: 'planned',
        step: 0,
        totalSteps: names.length,
        stepName: names[0] ?? 'committed',
        payload,
        before,
        after,
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        ...(requestId === undefined
          ? {}
          : {
              requestId,
              requestExpiresAt: new Date(
                this.now().getTime() + this.requestDedupeTtlMs,
              ).toISOString(),
            }),
      }
      await this.operations.put(record.id, record)
      return record
    })
  }

  /**
   * Execute every remaining step of an operation, persisting step progress.
   * A `contentRevision` conflict marks the operation `failed` and rethrows; a
   * crash-injection observer error propagates without finalizing, simulating a
   * process death.
   * @param operation - The operation to advance.
   * @returns The operation after all steps ran (still not committed).
   */
  async apply(operation: OperationRecord): Promise<OperationRecord> {
    return this.runExclusive(async () => {
      const steps = this.planFor(operation)
      let op: OperationRecord = {
        ...operation,
        status: 'applying',
        updatedAt: this.nowIso(),
      }
      await this.operations.put(op.id, op)
      for (let index = op.step; index < steps.length; index += 1) {
        const step = steps[index]!
        let failure: unknown
        try {
          await step.run()
        } catch (error) {
          failure = error
        }
        if (failure !== undefined) {
          if (isRetryableStorageFailure(failure)) {
            // Leave the operation `applying` at the current persisted step so a
            // later retry or restart can finish it without losing prior writes.
            throw failure instanceof Error ? failure : new Error(String(failure))
          }
          await this.fail(op, failure)
          throw failure instanceof Error
            ? failure
            : new OperationError('MEMORY_CONFLICT', String(failure))
        }
        op = {
          ...op,
          step: index + 1,
          stepName: steps[index + 1]?.name ?? 'committed',
          status: 'applying',
          updatedAt: this.nowIso(),
        }
        await this.operations.put(op.id, op)
        await this.observer.afterStep?.({ operation: op, stepName: step.name })
      }
      return op
    })
  }

  /**
   * Mark an operation failed without running any remaining steps. Used by
   * composite batches that keep partial progress but cannot complete.
   * @param operation - The interrupted operation.
   * @param error - Cause recorded on the operation.
   */
  async markFailed(operation: OperationRecord, error: unknown): Promise<void> {
    return this.runExclusive(async () => this.fail(operation, error))
  }

  /**
   * Finalize an applied operation as `committed`.
   * @param operation - Operation after `apply`.
   * @returns The committed record.
   */
  async commit(operation: OperationRecord): Promise<OperationRecord> {
    return this.runExclusive(async () => {
      const committed = this.committedRecord(operation)
      await this.operations.put(committed.id, committed)
      await this.pruneOperations()
      return committed
    })
  }

  /** Build the terminal record; permanent deletes never retain their own content snapshot. */
  private committedRecord(operation: OperationRecord): OperationRecord {
    const base: OperationRecord = {
      ...operation,
      status: 'committed',
      step: operation.totalSteps,
      stepName: 'committed',
      updatedAt: this.nowIso(),
    }
    if (operation.kind !== 'memory.delete') return base
    const payload = operation.payload as (DeletePayload & { memoryId?: string }) | undefined
    const memoryId = payload?.before?.id ?? payload?.memoryId
    return {
      ...base,
      payload: { redacted: true, ...(memoryId === undefined ? {} : { memoryId }) },
      before: undefined,
      after: undefined,
    }
  }

  /**
   * Remove every record-content snapshot of one memory from the operation log.
   *
   * A permanent deletion must leave no title/body text behind in `payload`,
   * `before` or `after` of ANY operation, including historical create/update
   * rows. Operations still in flight for that memory block the deletion so a
   * recovery cannot be corrupted.
   * @param memoryId - Memory identity being permanently erased.
   */
  async scrubMemoryContent(memoryId: string): Promise<void> {
    return this.runExclusive(async () => this.scrubMemoryContentUnlocked(memoryId))
  }

  /** Scrub every committed/failed operation snapshot of one memory, except the caller's own delete operation. */
  private async scrubMemoryContentUnlocked(
    memoryId: string,
    exceptOperationId?: string,
  ): Promise<void> {
    for (const [id, operation] of [...this.operations.entries()]) {
      if (id === exceptOperationId) continue
      if (!operationReferences(operation, memoryId)) continue
      if (operation.status !== 'committed' && operation.status !== 'failed') {
        throw new OperationError(
          'MEMORY_CONFLICT',
          `memory '${memoryId}' is referenced by an unfinished operation`,
        )
      }
      await this.operations.put(id, {
        ...operation,
        payload: { redacted: true, memoryId },
        before: undefined,
        after: undefined,
        updatedAt: this.nowIso(),
      })
    }
  }

  /**
   * Recover every interrupted operation on startup.
   *
   * Only persisted `planned` and `applying` records in `operations` are touched;
   * in-flight two-phase `DreamRun` entries without a `dream.run` operation are
   * intentionally left intact (timeout expiration is handled by
   * `MemoryEngine.failExpiredDreams()`).
   * @returns A report of what was committed, failed, or finalized.
   */
  async recover(): Promise<RecoveryReport> {
    return this.runExclusive(async () => {
      const outcomes: RecoveryOutcome[] = []
      for (const [, operation] of [...this.operations.entries()]) {
        if (operation.status !== 'planned' && operation.status !== 'applying') continue
        // One damaged row must never keep the whole service unready: every
        // branch fails only its own operation and recovery continues.
        try {
          if (operation.kind === 'dream.run') {
            const error = await this.finalizeDream(operation)
            outcomes.push({ id: operation.id, kind: operation.kind, outcome: 'failed', error })
            continue
          }
          if (operation.kind === 'dream.undo') {
            const dreamId = (operation.payload as { dreamId?: unknown } | undefined)?.dreamId
            if (typeof dreamId !== 'string' || dreamId === '') {
              throw new OperationError('MEMORY_CONFLICT', 'dream.undo operation has no dreamId')
            }
            await this.undoDreamInternal(dreamId)
            await this.writeDreamUndoAudit(operation, dreamId)
            const applied: OperationRecord = {
              ...operation,
              status: 'applying',
              step: 1,
              stepName: 'committed',
              updatedAt: this.nowIso(),
            }
            await this.operations.put(applied.id, applied)
            await this.commitUnlocked(applied)
            outcomes.push({
              id: operation.id,
              kind: operation.kind,
              outcome: 'committed',
            })
            continue
          }
          if (stepNames(operation.kind).length === 0) {
            const error = 'composite operation was not resumed; rerun it'
            await this.fail(operation, new Error(error))
            outcomes.push({ id: operation.id, kind: operation.kind, outcome: 'failed', error })
            continue
          }
          const applied = await this.applyUnlocked(operation)
          await this.commitUnlocked(applied)
          outcomes.push({ id: operation.id, kind: operation.kind, outcome: 'committed' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          try {
            await this.fail(operation, error)
          } catch {
            // A storage failure while recording the failure is reported to the
            // caller through the outcome; recovery still moves on.
          }
          outcomes.push({
            id: operation.id,
            kind: operation.kind,
            outcome: 'failed',
            error: message,
          })
        }
      }
      const committed = outcomes.filter((outcome) => outcome.outcome === 'committed').length
      return {
        recoveredAt: this.nowIso(),
        committed,
        failed: outcomes.length - committed,
        outcomes,
      }
    })
  }

  /**
   * Undo every dream-generated change recorded for one dream run.
   * @param dreamId - Dream run whose changes should be rolled back.
   * @returns How many changes were undone and skipped.
   */
  async undoDream(dreamId: string): Promise<DreamUndoReport> {
    const operation = await this.begin('dream.undo', { dreamId })
    try {
      const report = await this.undoDreamInternal(dreamId)
      await this.writeDreamUndoAudit(operation, dreamId)
      await this.commit({ ...operation, status: 'applying', step: 1, stepName: 'committed' })
      return report
    } catch (error) {
      await this.markFailed(operation, error)
      throw error
    }
  }

  private async undoDreamInternal(dreamId: string): Promise<DreamUndoReport> {
    const details: DreamUndoDetail[] = []
    let undone = 0
    let skipped = 0
    const records = [...this.audit.entries()]
      .map(([, record]) => record)
      .filter((record) => record.dreamId === dreamId && record.status === 'applied')
      // Only dream-generated changes are reversible here; user review actions
      // (accept/reject) and system/import changes are never undone.
      .filter((record) => record.actor === 'dream' || record.action === 'dream-commit')
    // A single dream can create a proposal and then update the same proposal
    // with a reworded candidate. Undo must walk each memory's chain backwards,
    // otherwise the create is skipped while the update restores an older body.
    records.reverse()
    for (const record of records) {
      const result = await this.undoAudit(record)
      if (result === 'undone') undone += 1
      else skipped += 1
      details.push({
        ...(record.memoryId === undefined ? {} : { memoryId: record.memoryId }),
        reason: result,
      })
    }
    return { dreamId, undone, skipped, details }
  }

  private async writeDreamUndoAudit(operation: OperationRecord, dreamId: string): Promise<void> {
    const id = this.auditId(operation)
    if (this.audit.get(id) !== undefined) return
    await this.audit.put(id, {
      id,
      operationId: operation.id,
      action: 'dream-undo',
      actor: 'system',
      status: 'applied',
      at: this.nowIso(),
      before: null,
      after: null,
      dreamId,
    })
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async applyUnlocked(operation: OperationRecord): Promise<OperationRecord> {
    const steps = this.planFor(operation)
    let op: OperationRecord = { ...operation, status: 'applying', updatedAt: this.nowIso() }
    await this.operations.put(op.id, op)
    for (let index = op.step; index < steps.length; index += 1) {
      const step = steps[index]!
      let failure: unknown
      try {
        await step.run()
      } catch (error) {
        failure = error
      }
      if (failure !== undefined) {
        if (isRetryableStorageFailure(failure)) {
          // Keep the durable `applying` state at the current step.
          throw failure instanceof Error ? failure : new Error(String(failure))
        }
        await this.fail(op, failure)
        throw failure instanceof Error
          ? failure
          : new OperationError('MEMORY_CONFLICT', String(failure))
      }
      op = {
        ...op,
        step: index + 1,
        stepName: steps[index + 1]?.name ?? 'committed',
        status: 'applying',
        updatedAt: this.nowIso(),
      }
      await this.operations.put(op.id, op)
    }
    return op
  }

  private async commitUnlocked(operation: OperationRecord): Promise<OperationRecord> {
    const committed = this.committedRecord(operation)
    await this.operations.put(committed.id, committed)
    await this.pruneOperations()
    return committed
  }

  private async fail(operation: OperationRecord, error: unknown): Promise<void> {
    const failed: OperationRecord = {
      ...operation,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: this.nowIso(),
    }
    if (operation.kind !== 'memory.delete') {
      await this.operations.put(failed.id, failed)
      return
    }
    // A failed permanent delete must not retain the content it was deleting:
    // its snapshots are stripped exactly like a committed delete.
    const payload = operation.payload as (DeletePayload & { memoryId?: string }) | undefined
    const memoryId = payload?.before?.id ?? payload?.memoryId
    await this.operations.put(failed.id, {
      ...failed,
      payload: { redacted: true, ...(memoryId === undefined ? {} : { memoryId }) },
      before: undefined,
      after: undefined,
    })
  }

  private findDeduped(requestId: string): OperationRecord | undefined {
    const nowMs = this.now().getTime()
    for (const [, operation] of [...this.operations.entries()]) {
      if (operation.requestId !== requestId) continue
      if (operation.requestExpiresAt === undefined) continue
      if (Date.parse(operation.requestExpiresAt) > nowMs) return operation
    }
    return undefined
  }

  private async pruneOperations(): Promise<void> {
    if (this.operations.size <= this.maxOperationRecords) return
    const removable = [...this.operations.entries()]
      .filter(([, operation]) => operation.status === 'committed' || operation.status === 'failed')
      .sort((left, right) => left[1].updatedAt.localeCompare(right[1].updatedAt))
    const overflow = this.operations.size - this.maxOperationRecords
    const victims = removable.slice(0, overflow).map(([id]) => id)
    if (victims.length > 0) await this.operations.deleteMany(victims)
  }

  private auditId(operation: OperationRecord): AuditId {
    return AuditId(`audit-${operation.id}`)
  }

  private async writeAudit(
    operation: OperationRecord,
    action: AuditRecord['action'],
    actor: AuditActor,
    before: MemoryRecord | null,
    after: MemoryRecord | null,
    memoryId: string | undefined,
    dreamId: string | undefined,
    reason?: string,
  ): Promise<void> {
    const id = this.auditId(operation)
    if (this.audit.get(id) !== undefined) return
    const record: AuditRecord = {
      id,
      operationId: operation.id,
      action,
      actor,
      before,
      after,
      status: 'applied',
      at: this.nowIso(),
      ...(memoryId === undefined ? {} : { memoryId }),
      ...(dreamId === undefined ? {} : { dreamId }),
      ...(reason === undefined ? {} : { reason }),
    }
    await this.audit.put(id, record)
    await this.pruneAudit()
  }

  private async pruneAudit(): Promise<void> {
    if (this.audit.size <= this.maxAuditRecords) return
    const cutoff = this.now().getTime() - MIN_UNDO_AUDIT_AGE_MS
    const removable = [...this.audit.entries()]
      .filter(([, record]) => record.status === 'applied' || record.status === 'undone')
      // Never prune inside the undo window: a dream run stays reversible for a
      // month, and user-visible history must not disappear under the cap.
      .filter(([, record]) => Date.parse(record.at) < cutoff)
      .sort((left, right) => left[1].at.localeCompare(right[1].at))
    const overflow = this.audit.size - this.maxAuditRecords
    const victims = removable.slice(0, overflow).map(([id]) => id)
    if (victims.length > 0) await this.audit.deleteMany(victims)
  }

  /** Write `after` when the current revision is the expected `before` revision. */
  private async writeRevisioned(before: MemoryRecord | null, after: MemoryRecord): Promise<void> {
    const validated = memoryRecordSchema.parse(after)
    const current = this.memories.get(validated.id)
    if (current === undefined) {
      if (before !== null) {
        throw new OperationError('MEMORY_CONFLICT', `memory '${validated.id}' is missing`)
      }
      await this.memories.put(validated.id, validated)
      return
    }
    if (before === null) {
      // A create retried after its row was already written is idempotent only
      // when the stored content matches; a different record under the same id
      // is a real conflict, never a silent no-op.
      if (current.contentHash === validated.contentHash) return
      throw new OperationError(
        'MEMORY_CONFLICT',
        `memory '${validated.id}' already exists with different content`,
      )
    }
    if (current.contentRevision === validated.contentRevision) return
    if (before !== null && current.contentRevision === before.contentRevision) {
      await this.memories.put(validated.id, validated)
      return
    }
    throw new OperationError(
      'MEMORY_CONFLICT',
      `memory '${validated.id}' changed to revision ${current.contentRevision}`,
    )
  }

  private planFor(operation: OperationRecord): Step[] {
    const names = stepNames(operation.kind)
    const steps: Step[] = []
    const kind = operation.kind
    if (kind === 'dream.run') {
      throw new OperationError(
        'MEMORY_CONFLICT',
        'dream.run execution is owned by the dreamer (plan 04)',
      )
    }
    if (ATOMIC_TWO_STEP.has(kind)) {
      const payload = operation.payload as PatchPayload | CreatePayload
      const action: AuditRecord['action'] =
        kind === 'memory.create'
          ? 'create'
          : kind === 'memory.update'
            ? 'update'
            : kind === 'memory.archive'
              ? 'archive'
              : kind === 'memory.restore'
                ? 'restore'
                : 'reject'
      const before = kind === 'memory.create' ? null : (payload as PatchPayload).before
      const after =
        kind === 'memory.create'
          ? (payload as CreatePayload).record
          : (payload as PatchPayload).after
      steps.push({
        name: names[0]!,
        run: async () => this.writeRevisioned(before, after),
      })
      steps.push({
        name: names[1]!,
        run: async () => {
          // A non-create change is only safe to finalize while the record still
          // carries the revision this operation wrote; a later user edit wins.
          if (kind !== 'memory.create') {
            const current = this.memories.get(after.id)
            if (current === undefined || current.contentRevision !== after.contentRevision) {
              throw new OperationError(
                'MEMORY_CONFLICT',
                `memory '${after.id}' was edited before the operation completed`,
              )
            }
          }
          await this.writeAudit(
            operation,
            action,
            payload.actor,
            before,
            after,
            after.id,
            payload.dreamId,
            'reason' in payload ? payload.reason : undefined,
          )
        },
      })
      return steps
    }
    switch (kind) {
      case 'memory.delete': {
        const payload = operation.payload as DeletePayload
        steps.push({
          name: names[0]!,
          run: async () =>
            this.writeAudit(
              operation,
              'delete',
              payload.actor,
              payload.minimalAudit === true ? null : payload.before,
              null,
              payload.before.id,
              undefined,
            ),
        })
        steps.push({
          name: names[1]!,
          run: async () => {
            const current = this.memories.get(payload.before.id)
            if (current === undefined) return
            if (current.contentRevision !== payload.before.contentRevision) {
              throw new OperationError(
                'MEMORY_CONFLICT',
                `memory '${payload.before.id}' changed before delete`,
              )
            }
            await this.memories.delete(payload.before.id)
          },
        })
        steps.push({
          name: names[2]!,
          run: async () => this.scrubMemoryContentUnlocked(payload.before.id, operation.id),
        })
        return steps
      }
      case 'memory.accept': {
        const payload = operation.payload as AcceptPayload
        steps.push({
          name: names[0]!,
          run: async () => {
            if (payload.old === null || payload.oldAfter === null) return
            await this.writeRevisioned(payload.old, payload.oldAfter)
          },
        })
        steps.push({
          name: names[1]!,
          run: async () => this.writeRevisioned(payload.newBefore, payload.after),
        })
        steps.push({
          name: names[2]!,
          run: async () =>
            this.writeAudit(
              operation,
              'accept',
              payload.actor,
              payload.old,
              payload.after,
              payload.after.id,
              payload.dreamId,
            ),
        })
        return steps
      }
      default:
        return []
    }
  }

  private async finalizeDream(operation: OperationRecord): Promise<string> {
    const payload = operation.payload as Partial<DreamRunPayload> | null | undefined
    const dreamId = payload?.dreamId
    if (typeof dreamId !== 'string' || dreamId === '') {
      const error = 'dream.run operation has no dreamId'
      await this.fail(operation, new Error(error))
      return error
    }
    const error = 'dream run was interrupted and was not resumed; pending proposals are retained'
    for (const [id, dream] of [...this.dreams.entries()]) {
      if (id !== dreamId) continue
      if (dream.status === 'running' || dream.status === 'queued') {
        const failed: DreamRun = { ...dream, status: 'failed', finishedAt: this.nowIso(), error }
        await this.dreams.put(id, failed)
      }
    }
    for (const [id, episode] of [...this.episodes.entries()]) {
      if (episode.status !== 'processing') continue
      if (episode.dreamId !== dreamId) continue
      const retryable: EpisodeRecord = {
        ...episode,
        status: 'failed-retryable',
        lastError: error,
        attempts: episode.attempts + 1,
      }
      await this.episodes.put(id, retryable)
    }
    await this.fail(operation, new Error(error))
    return error
  }

  private async undoAudit(record: AuditRecord): Promise<'undone' | 'skipped'> {
    if (record.memoryId === undefined) return 'skipped'
    const memoryId = record.memoryId
    const current = this.memories.get(memoryId as MemoryRecord['id'])
    const expectedRevision = record.after?.contentRevision
    if (record.action === 'delete') {
      if (current !== undefined) return 'skipped'
      if (record.before === null || record.before === undefined) return 'skipped'
      await this.memories.put(record.before.id, record.before)
    } else {
      if (current === undefined) return 'skipped'
      // A snapshot that belongs to another memory cannot be restored through
      // this audit row (e.g. an accept record spans old and new records).
      if (record.before !== null && record.before !== undefined && record.before.id !== memoryId) {
        return 'skipped'
      }
      if (expectedRevision === undefined || current.contentRevision !== expectedRevision) {
        return 'skipped'
      }
      if (record.before === null || record.before === undefined) {
        await this.memories.delete(current.id)
      } else {
        await this.memories.put(record.before.id, record.before)
      }
    }
    const undone: AuditRecord = { ...record, status: 'undone' }
    await this.audit.put(record.id, undone)
    return 'undone'
  }
}

/** The `id` of a value that looks like a memory record, if any. */
function memoryIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' ? record.id : undefined
}

/** Whether an operation payload or summary carries a snapshot of one memory. */
function operationReferences(operation: OperationRecord, memoryId: string): boolean {
  const payload = (operation.payload ?? {}) as Record<string, unknown>
  const candidates: unknown[] = [
    operation.before,
    operation.after,
    payload.record,
    payload.before,
    payload.after,
    payload.old,
    payload.oldAfter,
    payload.newBefore,
  ]
  return candidates.some((candidate) => memoryIdOf(candidate) === memoryId)
}

function summarize(payload: unknown): { before: unknown; after: unknown } {
  if (payload === null || typeof payload !== 'object')
    return { before: undefined, after: undefined }
  const value = payload as Record<string, unknown>
  if ('record' in value) return { before: null, after: value.record }
  if ('after' in value) {
    return {
      before: 'before' in value ? value.before : 'old' in value ? value.old : undefined,
      after: value.after,
    }
  }
  if ('before' in value) return { before: value.before, after: null }
  return { before: undefined, after: undefined }
}

/**
 * Storage failures leave the operation resumable; business and validation
 * failures are terminal. A zod validation error is not a transient backend
 * failure even though it is not an {@link OperationError}.
 */
function isRetryableStorageFailure(error: unknown): boolean {
  if (error instanceof OperationError) return false
  if (typeof error === 'object' && error !== null && 'issues' in error) return false
  return true
}

/** Operation status helper for callers that only need the terminal check. */
export function isCommitted(operation: OperationRecord): boolean {
  return operation.status === ('committed' satisfies OperationStatus)
}
