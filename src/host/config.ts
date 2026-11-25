/**
 * Plugin configuration (schemastery) mirroring design §8.
 *
 * Every tunable lives here with the documented default; the loader validates a
 * user patch against this schema and later versions retain the user patch layer.
 * @module dsh-memory/host/config
 */
import z from '@deepseek-ai/schemastery'
import {
  MEMORY_CONFIG_DEFAULTS,
  type MemoryConfig,
  type ResolvedMemoryConfig,
} from '../core/config.ts'

export type { MemoryConfig, ResolvedMemoryConfig }

const fields = {
  enabled: z.boolean().default(MEMORY_CONFIG_DEFAULTS.enabled),
  indexMaxBytes: z
    .number()
    .min(1024)
    .max(32768)
    .step(1)
    .default(MEMORY_CONFIG_DEFAULTS.indexMaxBytes),
  autoCaptureEpisodes: z.boolean().default(MEMORY_CONFIG_DEFAULTS.autoCaptureEpisodes),
  autoDream: z.boolean().default(MEMORY_CONFIG_DEFAULTS.autoDream),
  autoAcceptProposals: z.boolean().default(MEMORY_CONFIG_DEFAULTS.autoAcceptProposals),
  dreamIdleDelayMs: z.natural().default(MEMORY_CONFIG_DEFAULTS.dreamIdleDelayMs),
  autoDreamMinIntervalMs: z.natural().default(MEMORY_CONFIG_DEFAULTS.autoDreamMinIntervalMs),
  dreamModelMode: z
    .union([z.const('follow-session'), z.const('fixed')])
    .default(MEMORY_CONFIG_DEFAULTS.dreamModelMode),
  dreamProvider: z.string(),
  dreamModel: z.string(),
  dreamReasoningEffort: z.string(),
  dreamMaxEpisodes: z.natural().default(MEMORY_CONFIG_DEFAULTS.dreamMaxEpisodes),
  dreamMaxSessionsPerRun: z.natural().default(MEMORY_CONFIG_DEFAULTS.dreamMaxSessionsPerRun),
  dreamMaxTokens: z.natural().default(MEMORY_CONFIG_DEFAULTS.dreamMaxTokens),
  dreamLookbackDays: z.natural().default(MEMORY_CONFIG_DEFAULTS.dreamLookbackDays),
  requestDedupeTtlMs: z.natural().default(MEMORY_CONFIG_DEFAULTS.requestDedupeTtlMs),
  dreamProcessingTimeoutMs: z.natural().default(MEMORY_CONFIG_DEFAULTS.dreamProcessingTimeoutMs),
  refreshIndexOnChange: z.boolean().default(MEMORY_CONFIG_DEFAULTS.refreshIndexOnChange),
  refreshMinIntervalMs: z.natural().default(MEMORY_CONFIG_DEFAULTS.refreshMinIntervalMs),
  refreshMaxBytes: z.natural().default(MEMORY_CONFIG_DEFAULTS.refreshMaxBytes),
  refreshResetBytes: z.natural().default(MEMORY_CONFIG_DEFAULTS.refreshResetBytes),
  worklogCapture: z
    .union([z.const('significant'), z.const('off')])
    .default(MEMORY_CONFIG_DEFAULTS.worklogCapture),
  worklogRetentionDays: z.natural().default(MEMORY_CONFIG_DEFAULTS.worklogRetentionDays),
  episodeRetentionDays: z.natural().default(MEMORY_CONFIG_DEFAULTS.episodeRetentionDays),
  maxActiveMemories: z.natural().default(MEMORY_CONFIG_DEFAULTS.maxActiveMemories),
  maxArchivedMemories: z.natural().default(MEMORY_CONFIG_DEFAULTS.maxArchivedMemories),
  maxStoredMemories: z.natural().default(MEMORY_CONFIG_DEFAULTS.maxStoredMemories),
  maxQueuedEpisodes: z.natural().default(MEMORY_CONFIG_DEFAULTS.maxQueuedEpisodes),
  maxAuditRecords: z.natural().default(MEMORY_CONFIG_DEFAULTS.maxAuditRecords),
  maxOperationRecords: z.natural().default(MEMORY_CONFIG_DEFAULTS.maxOperationRecords),
  archivePurgePolicy: z
    .union([z.const('manual'), z.const('after-export'), z.const('age')])
    .default(MEMORY_CONFIG_DEFAULTS.archivePurgePolicy),
  archiveRetentionDays: z.natural().default(MEMORY_CONFIG_DEFAULTS.archiveRetentionDays),
  rebuildLookbackDays: z.natural().default(MEMORY_CONFIG_DEFAULTS.rebuildLookbackDays),
  injectForSubagents: z.boolean().default(MEMORY_CONFIG_DEFAULTS.injectForSubagents),
  redactSecrets: z.boolean().default(MEMORY_CONFIG_DEFAULTS.redactSecrets),
  searchLimit: z.natural().default(MEMORY_CONFIG_DEFAULTS.searchLimit),
} as const

const CONFIG_KEYS = new Set(Object.keys(fields))

/** Schemastery schema for the memory plugin config; rejects unknown fields. */
const schema = z.object(fields)
const standard = (
  schema as unknown as {
    '~standard': {
      version: number
      vendor: string
      validate(data: unknown): unknown
    }
  }
)['~standard']
Object.defineProperty(schema, '~standard', {
  configurable: true,
  value: {
    ...standard,
    validate(data: unknown): unknown {
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const unknown = Object.keys(data).filter((key) => !CONFIG_KEYS.has(key))
        if (unknown.length > 0) {
          return {
            issues: unknown.map((key) => ({
              message: `unknown config field "${key}"`,
              path: [key],
            })),
          }
        }
      }
      return standard.validate(data)
    },
  },
})

export const Config = schema

/**
 * Resolve a raw config patch into a fully-defaulted config.
 *
 * Defaults apply only where the patch omits a value; explicit values win.
 * @param raw - Optional user patch.
 * @returns The resolved configuration.
 * @throws when an unknown field is present.
 */
export function resolveMemoryConfig(raw?: Partial<MemoryConfig> | null): MemoryConfig {
  if (raw !== undefined && raw !== null) {
    const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key))
    if (unknown.length > 0) {
      throw new TypeError(`unknown config field(s): ${unknown.join(', ')}`)
    }
  }
  return Config((raw ?? {}) as never) as unknown as MemoryConfig
}
