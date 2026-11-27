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

/** Installation and enabled status of the Memloom/dsh-memory plugin in a host. */
export type HostPluginState = 'enabled' | 'disabled' | 'not-installed' | 'unknown'

/** Probed host plugin installation, version, and enabled state. */
export interface HostPluginStatus {
  readonly state: HostPluginState
  readonly installed: boolean
  readonly enabled: boolean | null
  readonly version?: string
  readonly pluginName?: string
  readonly installPath?: string
  readonly detail?: string
}

/** Built-in DSH or AGY store discovered on the local machine. */
export interface DiscoveredStore {
  readonly id: string
  readonly name: string
  readonly kind: 'dsh' | 'agy'
  readonly storePath: string
  readonly profileName?: string
  readonly pluginStatus?: HostPluginStatus
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
