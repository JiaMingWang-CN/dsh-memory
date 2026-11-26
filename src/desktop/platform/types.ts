/**
 * Cross-platform abstraction contracts for Memloom Desktop.
 * @module memloom/desktop/platform/types
 */

/** Result of probing whether any DSH host or desktop process is currently running. */
export interface DshProcessProbeResult {
  readonly running: boolean
  readonly uncertain: boolean
  readonly matchedProcesses: readonly string[]
  readonly error?: string
}

/** Built-in DSH or AGY store discovered on the local machine. */
export interface DiscoveredStore {
  readonly id: string
  readonly name: string
  readonly kind: 'dsh' | 'agy'
  readonly storePath: string
  readonly profileName?: string
}

/** Result of resolving the default AGY store and any legacy `dsh-memory` candidate. */
export interface AgyDiscoveryResult {
  readonly primary: DiscoveredStore
  readonly legacyCandidatePath?: string
}

/** Platform-specific adapter for process probing and default store discovery. */
export interface PlatformAdapter {
  readonly platform: NodeJS.Platform
  detectDshProcesses(): Promise<DshProcessProbeResult>
  resolveDefaultDshStores(env?: NodeJS.ProcessEnv): Promise<DiscoveredStore[]>
  resolveDefaultAgyStore(env?: NodeJS.ProcessEnv): Promise<AgyDiscoveryResult>
}
