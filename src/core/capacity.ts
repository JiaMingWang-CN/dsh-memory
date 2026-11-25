/**
 * Capacity policy for memory tables.
 *
 * `maxStoredMemories` and `maxArchivedMemories` are hard caps that reject new
 * records; `maxActiveMemories` demotes low-value `derived` records to
 * `archived` when new knowledge arrives, but never archives a record the user
 * owns or pinned: user data is protected by refusing the write instead.
 * @module dsh-memory/core/capacity
 */
import type { MemoryRecord } from '../shared/types.ts'
import type { StoreCounts } from './store.ts'
import { OperationError } from './operations.ts'

export interface CapacityLimits {
  maxActiveMemories: number
  maxArchivedMemories: number
  maxStoredMemories: number
  maxQueuedEpisodes?: number
}

/** Lower is a better archival candidate: low importance first, then older updates. */
function retentionScore(record: MemoryRecord): number {
  return record.importance
}

/** Only unreviewed, unpinned dream output may be demoted automatically. */
function archivable(record: MemoryRecord): boolean {
  return !record.pinned && record.ownership === 'derived'
}

export class CapacityPolicy {
  private readonly limits: CapacityLimits

  constructor(limits: CapacityLimits) {
    this.limits = limits
  }

  /** The configured active-record ceiling. */
  get activeLimit(): number {
    return this.limits.maxActiveMemories
  }

  /**
   * Throw `MEMORY_CAPACITY` when the archived or stored hard cap is reached.
   * @param counts - Current per-status counts.
   */
  checkCreate(counts: StoreCounts): void {
    if (counts.stored >= this.limits.maxStoredMemories) {
      throw new OperationError('MEMORY_CAPACITY', 'stored memory limit reached')
    }
    this.onArchivedOverflow(counts)
  }

  /**
   * Throw `MEMORY_CAPACITY` when post-batch totals exceed hard caps.
   * Unlike {@link checkCreate}, `counts` here already reflects the records
   * after planned deletions and additions, so exact equality with the limit is
   * allowed. Archived overflow is only checked when the batch actually adds
   * archived records.
   * @param counts - Post-batch per-status counts.
   * @param addedArchived - Number of archived records added by the batch.
   */
  checkBatchTotals(counts: StoreCounts, addedArchived: number): void {
    if (counts.stored > this.limits.maxStoredMemories) {
      throw new OperationError('MEMORY_CAPACITY', 'stored memory limit reached')
    }
    if (addedArchived > 0 && counts.archived > this.limits.maxArchivedMemories) {
      throw new OperationError('MEMORY_CAPACITY', 'archived memory limit reached')
    }
  }

  /**
   * Throw `MEMORY_CAPACITY` when the archived cap is reached.
   * @param counts - Current per-status counts.
   */
  onArchivedOverflow(counts: StoreCounts): void {
    if (counts.archived >= this.limits.maxArchivedMemories) {
      throw new OperationError('MEMORY_CAPACITY', 'archived memory limit reached')
    }
  }

  /**
   * Throw `MEMORY_CAPACITY` when activating one record would exceed the cap
   * after `freed` records are archived by the same action.
   * @param activeCount - Current number of active records.
   * @param freed - Active records the same operation archives first.
   */
  assertActiveRoom(activeCount: number, freed = 0): void {
    if (activeCount - freed + 1 > this.limits.maxActiveMemories) {
      throw new OperationError('MEMORY_CAPACITY', 'active memory limit reached')
    }
  }

  /**
   * Throw `MEMORY_CAPACITY` when the queued-episode hard cap is reached.
   * @param counts - Current per-status counts.
   */
  checkEpisodeQueue(counts: StoreCounts): void {
    if (
      this.limits.maxQueuedEpisodes !== undefined &&
      counts.queuedEpisodes >= this.limits.maxQueuedEpisodes
    ) {
      throw new OperationError('MEMORY_CAPACITY', 'queued episode limit reached')
    }
  }

  /**
   * Select the active records to archive so that, after adding `incoming`, the
   * active count returns within `maxActiveMemories`. Pinned and user-owned
   * records are never selected.
   * @param active - Current active records.
   * @param incoming - Number of records about to be created (default 1).
   * @returns Records to archive, lowest score first.
   */
  onActiveOverflow(active: MemoryRecord[], incoming = 1): MemoryRecord[] {
    const overflow = active.length + incoming - this.limits.maxActiveMemories
    if (overflow <= 0) return []
    return active
      .filter(archivable)
      .sort(
        (left, right) =>
          retentionScore(left) - retentionScore(right) ||
          Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, overflow)
  }
}
