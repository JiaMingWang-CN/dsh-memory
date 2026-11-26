/**
 * Concurrent write-guard state machine protecting DSH stores from silent overwrites.
 * @module memloom/desktop/write-guard
 */
import type { DshProcessProbeResult, PlatformAdapter } from './platform/types.ts'

/** Operational mode of the DSH concurrent write guard. */
export type WriteGuardMode = 'writable' | 'readonly-dsh-running' | 'force-unlocked'

/** Point-in-time snapshot of the write-guard state and latest DSH process probe. */
export interface WriteGuardSnapshot {
  readonly mode: WriteGuardMode
  readonly dshRunning: boolean
  readonly uncertain: boolean
  readonly matchedProcesses: readonly string[]
  readonly checkedAt: string
  readonly reason?: string
}

/** Error thrown when a write operation targets a DSH-protected client in read-only mode. */
export class DesktopReadonlyGuardError extends Error {
  readonly code = 'desktop/readonly-guard'
  readonly snapshot: WriteGuardSnapshot

  constructor(snapshot: WriteGuardSnapshot, message?: string) {
    super(
      message ??
        snapshot.reason ??
        'DSH is running or cannot be verified closed; write access is blocked.',
    )
    this.name = 'DesktopReadonlyGuardError'
    this.snapshot = snapshot
  }
}

function buildProbeReason(probe: DshProcessProbeResult): string | undefined {
  if (probe.uncertain) {
    return probe.error
      ? `Unable to verify whether DSH is closed (${probe.error}); read-only protection enabled.`
      : 'Unable to verify whether DSH is closed; read-only protection enabled.'
  }
  if (probe.running) {
    return `DSH process running (${probe.matchedProcesses.join(', ')}); read-only protection enabled.`
  }
  return undefined
}

/**
 * Fail-closed write-guard state machine for DSH-protected stores.
 * Starts in `readonly-dsh-running` until a probe confirms DSH is not running.
 */
export class WriteGuard {
  private readonly platform: PlatformAdapter
  private readonly now: () => Date
  private snapshot: WriteGuardSnapshot

  constructor(platform: PlatformAdapter, now: () => Date = () => new Date()) {
    this.platform = platform
    this.now = now
    this.snapshot = {
      mode: 'readonly-dsh-running',
      dshRunning: false,
      uncertain: true,
      matchedProcesses: [],
      checkedAt: this.now().toISOString(),
      reason: 'DSH process status has not been checked yet; read-only protection enabled.',
    }
  }

  /** Probe DSH processes and transition state according to fail-closed rules. */
  async refresh(): Promise<WriteGuardSnapshot> {
    let probe: DshProcessProbeResult
    try {
      probe = await this.platform.detectDshProcesses()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      probe = {
        running: false,
        uncertain: true,
        matchedProcesses: [],
        error: message,
      }
    }

    const checkedAt = this.now().toISOString()

    if (!probe.running && !probe.uncertain) {
      this.snapshot = {
        mode: 'writable',
        dshRunning: false,
        uncertain: false,
        matchedProcesses: [...probe.matchedProcesses],
        checkedAt,
      }
      return this.snapshot
    }

    const nextMode: WriteGuardMode =
      this.snapshot.mode === 'force-unlocked' ? 'force-unlocked' : 'readonly-dsh-running'
    const reason =
      nextMode === 'force-unlocked'
        ? 'Force-unlocked for this session by explicit user confirmation.'
        : buildProbeReason(probe)

    this.snapshot = {
      mode: nextMode,
      dshRunning: probe.running,
      uncertain: probe.uncertain,
      matchedProcesses: [...probe.matchedProcesses],
      checkedAt,
      ...(reason !== undefined ? { reason } : {}),
    }
    return this.snapshot
  }

  /** Return the most recent {@link WriteGuardSnapshot}. */
  getSnapshot(): WriteGuardSnapshot {
    return this.snapshot
  }

  /** Return whether writes are currently permitted for a client with the given protection flag. */
  isClientWritable(dshProtected: boolean): boolean {
    if (!dshProtected) return true
    return this.snapshot.mode !== 'readonly-dsh-running'
  }

  /** Throw {@link DesktopReadonlyGuardError} if the client is protected and currently read-only. */
  assertClientWritable(dshProtected: boolean): void {
    if (!this.isClientWritable(dshProtected)) {
      throw new DesktopReadonlyGuardError(this.snapshot)
    }
  }

  /**
   * Enter session-level `force-unlocked` mode when explicitly confirmed by the user.
   * Rejects with {@link DesktopReadonlyGuardError} when `confirmed` is `false`.
   */
  forceUnlock(confirmed: boolean): WriteGuardSnapshot {
    if (!confirmed) {
      throw new DesktopReadonlyGuardError(
        this.snapshot,
        'Explicit risk confirmation is required to force-unlock DSH write protection.',
      )
    }
    if (this.snapshot.mode === 'writable') {
      return this.snapshot
    }
    this.snapshot = {
      ...this.snapshot,
      mode: 'force-unlocked',
      checkedAt: this.now().toISOString(),
      reason: 'Force-unlocked for this session by explicit user confirmation.',
    }
    return this.snapshot
  }

  /** Re-engage `readonly-dsh-running` protection from `force-unlocked` (or uncertain/running state). */
  relock(): WriteGuardSnapshot {
    if (
      this.snapshot.mode === 'force-unlocked' ||
      this.snapshot.dshRunning ||
      this.snapshot.uncertain
    ) {
      this.snapshot = {
        ...this.snapshot,
        mode: 'readonly-dsh-running',
        checkedAt: this.now().toISOString(),
        reason: 'Read-only protection re-engaged.',
      }
    }
    return this.snapshot
  }
}
