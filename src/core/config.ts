/**
 * Host-agnostic plugin configuration defaults and zod validation.
 *
 * Mirrors every field and default of `src/host/config.ts` without any
 * DSH runtime dependency so both DSH and AGY share one canonical config
 * contract.
 * @module dsh-memory/core/config
 */
import { z } from 'zod'
import { OperationError } from './operations.ts'

/** Memory plugin configuration (all fields optional as a patch). */
export interface MemoryConfig {
  enabled?: boolean
  indexMaxBytes?: number
  autoCaptureEpisodes?: boolean
  autoDream?: boolean
  autoAcceptProposals?: boolean
  dreamIdleDelayMs?: number
  autoDreamMinIntervalMs?: number
  dreamModelMode?: 'follow-session' | 'fixed'
  dreamProvider?: string
  dreamModel?: string
  dreamReasoningEffort?: string
  dreamMaxEpisodes?: number
  dreamMaxSessionsPerRun?: number
  dreamMaxTokens?: number
  dreamLookbackDays?: number
  requestDedupeTtlMs?: number
  dreamProcessingTimeoutMs?: number
  refreshIndexOnChange?: boolean
  refreshMinIntervalMs?: number
  refreshMaxBytes?: number
  refreshResetBytes?: number
  worklogCapture?: 'significant' | 'off'
  worklogRetentionDays?: number
  episodeRetentionDays?: number
  maxActiveMemories?: number
  maxArchivedMemories?: number
  maxStoredMemories?: number
  maxQueuedEpisodes?: number
  maxAuditRecords?: number
  maxOperationRecords?: number
  archivePurgePolicy?: 'manual' | 'after-export' | 'age'
  archiveRetentionDays?: number
  rebuildLookbackDays?: number
  injectForSubagents?: boolean
  redactSecrets?: boolean
  searchLimit?: number
}

/** Resolved memory plugin configuration with all defaulted fields populated. */
export type ResolvedMemoryConfig = Required<
  Omit<MemoryConfig, 'dreamProvider' | 'dreamModel' | 'dreamReasoningEffort'>
> &
  Pick<MemoryConfig, 'dreamProvider' | 'dreamModel' | 'dreamReasoningEffort'>

/** Canonical default values matching `src/host/config.ts` and `docs/configuration.md`. */
export const MEMORY_CONFIG_DEFAULTS: Required<
  Omit<MemoryConfig, 'dreamProvider' | 'dreamModel' | 'dreamReasoningEffort'>
> = {
  enabled: true,
  indexMaxBytes: 4096,
  autoCaptureEpisodes: true,
  autoDream: false,
  autoAcceptProposals: false,
  dreamIdleDelayMs: 30_000,
  autoDreamMinIntervalMs: 300_000,
  dreamModelMode: 'follow-session',
  dreamMaxEpisodes: 40,
  dreamMaxSessionsPerRun: 10,
  dreamMaxTokens: 4096,
  dreamLookbackDays: 7,
  requestDedupeTtlMs: 86_400_000,
  dreamProcessingTimeoutMs: 600_000,
  refreshIndexOnChange: false,
  refreshMinIntervalMs: 60_000,
  refreshMaxBytes: 2048,
  refreshResetBytes: 8192,
  worklogCapture: 'significant',
  worklogRetentionDays: 90,
  episodeRetentionDays: 30,
  maxActiveMemories: 5000,
  maxArchivedMemories: 20_000,
  maxStoredMemories: 25_000,
  maxQueuedEpisodes: 5000,
  maxAuditRecords: 20_000,
  maxOperationRecords: 10_000,
  archivePurgePolicy: 'manual',
  archiveRetentionDays: 365,
  rebuildLookbackDays: 90,
  injectForSubagents: false,
  redactSecrets: true,
  searchLimit: 20,
}

/** The 23 runtime configuration keys editable from AGY `memory_config`. */
export const AGY_EDITABLE_CONFIG_FIELDS: readonly (keyof MemoryConfig)[] = [
  'enabled',
  'indexMaxBytes',
  'autoCaptureEpisodes',
  'autoDream',
  'autoAcceptProposals',
  'dreamIdleDelayMs',
  'autoDreamMinIntervalMs',
  'dreamMaxEpisodes',
  'dreamLookbackDays',
  'dreamProcessingTimeoutMs',
  'refreshIndexOnChange',
  'refreshMinIntervalMs',
  'refreshMaxBytes',
  'refreshResetBytes',
  'worklogCapture',
  'worklogRetentionDays',
  'episodeRetentionDays',
  'archivePurgePolicy',
  'archiveRetentionDays',
  'rebuildLookbackDays',
  'injectForSubagents',
  'redactSecrets',
  'searchLimit',
] as const

const natural = () => z.number().int().nonnegative()

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    indexMaxBytes: z.number().int().min(1024).max(32_768).optional(),
    autoCaptureEpisodes: z.boolean().optional(),
    autoDream: z.boolean().optional(),
    autoAcceptProposals: z.boolean().optional(),
    dreamIdleDelayMs: natural().optional(),
    autoDreamMinIntervalMs: natural().optional(),
    dreamModelMode: z.enum(['follow-session', 'fixed']).optional(),
    dreamProvider: z.string().optional(),
    dreamModel: z.string().optional(),
    dreamReasoningEffort: z.string().optional(),
    dreamMaxEpisodes: natural().optional(),
    dreamMaxSessionsPerRun: natural().optional(),
    dreamMaxTokens: natural().optional(),
    dreamLookbackDays: natural().optional(),
    requestDedupeTtlMs: natural().optional(),
    dreamProcessingTimeoutMs: natural().optional(),
    refreshIndexOnChange: z.boolean().optional(),
    refreshMinIntervalMs: natural().optional(),
    refreshMaxBytes: natural().optional(),
    refreshResetBytes: natural().optional(),
    worklogCapture: z.enum(['significant', 'off']).optional(),
    worklogRetentionDays: natural().optional(),
    episodeRetentionDays: natural().optional(),
    maxActiveMemories: natural().optional(),
    maxArchivedMemories: natural().optional(),
    maxStoredMemories: natural().optional(),
    maxQueuedEpisodes: natural().optional(),
    maxAuditRecords: natural().optional(),
    maxOperationRecords: natural().optional(),
    archivePurgePolicy: z.enum(['manual', 'after-export', 'age']).optional(),
    archiveRetentionDays: natural().optional(),
    rebuildLookbackDays: natural().optional(),
    injectForSubagents: z.boolean().optional(),
    redactSecrets: z.boolean().optional(),
    searchLimit: natural().optional(),
  })
  .strict()

const CONFIG_KEYS = new Set<string>([
  ...Object.keys(MEMORY_CONFIG_DEFAULTS),
  'dreamProvider',
  'dreamModel',
  'dreamReasoningEffort',
])

/**
 * Validate a raw configuration patch against the shared config schema.
 * @param raw - Unknown candidate patch object.
 * @returns A clean partial config containing only defined validated fields.
 * @throws `OperationError('MEMORY_INVALID_CONFIG', ...)` on unknown or invalid fields.
 */
export function validateMemoryConfigPatch(raw: unknown): Partial<MemoryConfig> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OperationError('MEMORY_INVALID_CONFIG', 'invalid config patch: expected an object')
  }
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) {
    throw new OperationError(
      'MEMORY_INVALID_CONFIG',
      `unknown config field(s): ${unknown.join(', ')}`,
    )
  }
  const parsed = patchSchema.safeParse(raw)
  if (!parsed.success) {
    throw new OperationError(
      'MEMORY_INVALID_CONFIG',
      parsed.error.issues[0]?.message ?? parsed.error.message,
    )
  }
  const clean: Partial<MemoryConfig> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      ;(clean as Record<string, unknown>)[key] = value
    }
  }
  return clean
}

/**
 * Resolve an optional config patch into a fully defaulted {@link ResolvedMemoryConfig}.
 * @param patch - Optional user configuration patch.
 * @returns The resolved configuration with defaults applied where omitted.
 */
export function resolveMemoryConfig(patch?: Partial<MemoryConfig> | null): ResolvedMemoryConfig {
  const validated = patch === undefined || patch === null ? {} : validateMemoryConfigPatch(patch)
  return {
    ...MEMORY_CONFIG_DEFAULTS,
    ...validated,
  }
}
