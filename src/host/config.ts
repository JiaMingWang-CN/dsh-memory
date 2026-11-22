/**
 * Plugin configuration (schemastery) mirroring design §8.
 *
 * Every tunable lives here with the documented default; the loader validates a
 * user patch against this schema and later versions retain the user patch layer.
 * @module dsh-memory/host/config
 */
import z from '@deepseek-ai/schemastery'

/** Resolved plugin configuration. */
export interface MemoryConfig {
  enabled?: boolean
  indexMaxBytes?: number
  autoCaptureEpisodes?: boolean
  autoDream?: boolean
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

const fields = {
  enabled: z.boolean().default(true),
  indexMaxBytes: z.number().min(1024).max(32768).step(1).default(4096),
  autoCaptureEpisodes: z.boolean().default(true),
  autoDream: z.boolean().default(false),
  dreamIdleDelayMs: z.natural().default(30_000),
  autoDreamMinIntervalMs: z.natural().default(300_000),
  dreamModelMode: z.union([z.const('follow-session'), z.const('fixed')]).default('follow-session'),
  dreamProvider: z.string(),
  dreamModel: z.string(),
  dreamReasoningEffort: z.string(),
  dreamMaxEpisodes: z.natural().default(40),
  dreamMaxSessionsPerRun: z.natural().default(10),
  dreamMaxTokens: z.natural().default(4096),
  dreamLookbackDays: z.natural().default(7),
  requestDedupeTtlMs: z.natural().default(86_400_000),
  dreamProcessingTimeoutMs: z.natural().default(600_000),
  refreshIndexOnChange: z.boolean().default(false),
  refreshMinIntervalMs: z.natural().default(60_000),
  refreshMaxBytes: z.natural().default(2048),
  refreshResetBytes: z.natural().default(8192),
  worklogCapture: z.union([z.const('significant'), z.const('off')]).default('significant'),
  worklogRetentionDays: z.natural().default(90),
  episodeRetentionDays: z.natural().default(30),
  maxActiveMemories: z.natural().default(5000),
  maxArchivedMemories: z.natural().default(20_000),
  maxStoredMemories: z.natural().default(25_000),
  maxQueuedEpisodes: z.natural().default(5000),
  maxAuditRecords: z.natural().default(20_000),
  maxOperationRecords: z.natural().default(10_000),
  archivePurgePolicy: z
    .union([z.const('manual'), z.const('after-export'), z.const('age')])
    .default('manual'),
  archiveRetentionDays: z.natural().default(365),
  rebuildLookbackDays: z.natural().default(90),
  injectForSubagents: z.boolean().default(false),
  redactSecrets: z.boolean().default(true),
  searchLimit: z.natural().default(20),
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
