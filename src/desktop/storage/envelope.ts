/**
 * Dual-format outer JSON envelope detection, parsing, and lossless serialization
 * for `dsh-unit` (`{ unit, global, tables }`) and `agy-flat` (`{ name, version, ...tables }`).
 * @module memloom/desktop/storage/envelope
 */
import { OperationError } from '../../core/operations.ts'
import {
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  type MemoryTableName,
} from '../../core/storage-contract.ts'

export const MEMORY_TABLE_NAMES: readonly MemoryTableName[] = [
  'memories',
  'episodes',
  'dreams',
  'audit',
  'operations',
  'session_cursors',
]

export type StoreEnvelopeFormat = 'dsh-unit' | 'agy-flat'

export interface ParsedStoreEnvelope {
  readonly format: StoreEnvelopeFormat
  readonly unit?: {
    readonly name: string
    readonly version: number
    readonly [key: string]: unknown
  }
  readonly global?: unknown
  readonly rawTables: Record<MemoryTableName, Record<string, unknown>>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function createEmptyRawTables(): Record<MemoryTableName, Record<string, unknown>> {
  return {
    memories: {},
    episodes: {},
    dreams: {},
    audit: {},
    operations: {},
    session_cursors: {},
  }
}

/**
 * Detect whether a parsed JSON value represents a `dsh-unit` or `agy-flat` store envelope.
 * Returns `null` when the shape matches neither recognized format.
 */
export function detectEnvelopeFormat(raw: unknown): StoreEnvelopeFormat | null {
  if (!isPlainObject(raw)) {
    return null
  }

  if ('unit' in raw || 'tables' in raw) {
    if (isPlainObject(raw.unit) && isPlainObject(raw.tables)) {
      return 'dsh-unit'
    }
    return null
  }

  if (
    'name' in raw ||
    'version' in raw ||
    MEMORY_TABLE_NAMES.some((tableName) => tableName in raw)
  ) {
    return 'agy-flat'
  }

  return null
}

/**
 * Parse and validate outer envelope bytes from disk without modifying or overwriting the source file.
 * Throws `OperationError('MEMORY_UNAVAILABLE', ...)` if JSON is malformed or the envelope is invalid.
 */
export function parseStoreEnvelope(rawBytes: Buffer, storePath: string): ParsedStoreEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBytes.toString('utf8'))
  } catch (err) {
    throw new OperationError(
      'MEMORY_UNAVAILABLE',
      `Memory store at ${storePath} contains invalid JSON (${err instanceof Error ? err.message : String(err)}); refusing to overwrite. Inspect or restore the file manually.`,
    )
  }

  if (!isPlainObject(parsed)) {
    throw new OperationError(
      'MEMORY_UNAVAILABLE',
      `Memory store at ${storePath} must be a JSON object; refusing to overwrite.`,
    )
  }

  const format = detectEnvelopeFormat(parsed)
  if (format === null) {
    throw new OperationError(
      'MEMORY_UNAVAILABLE',
      `Memory store at ${storePath} has an unrecognized envelope format; refusing to overwrite.`,
    )
  }

  const rawTables = createEmptyRawTables()

  if (format === 'dsh-unit') {
    const unitRaw = parsed.unit as Record<string, unknown>
    const tablesRaw = parsed.tables as Record<string, unknown>
    if (unitRaw.name !== MEMORY_DOMAIN_NAME || unitRaw.version !== MEMORY_DOMAIN_VERSION) {
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Memory store at ${storePath} has unexpected DSH unit header (name=${String(unitRaw.name)}, version=${String(unitRaw.version)}); refusing to overwrite.`,
      )
    }

    for (const tableName of MEMORY_TABLE_NAMES) {
      const container = tablesRaw[tableName]
      if (container !== undefined && !isPlainObject(container)) {
        throw new OperationError(
          'MEMORY_UNAVAILABLE',
          `Memory store at ${storePath} has invalid table container "${tableName}"; refusing to overwrite.`,
        )
      }
      if (container !== undefined) {
        rawTables[tableName] = container
      }
    }

    const unit: {
      readonly name: string
      readonly version: number
      readonly [key: string]: unknown
    } = {
      ...unitRaw,
      name: MEMORY_DOMAIN_NAME,
      version: MEMORY_DOMAIN_VERSION,
    }

    return {
      format: 'dsh-unit',
      unit,
      ...('global' in parsed ? { global: parsed.global } : {}),
      rawTables,
    }
  }

  if (
    (parsed.name !== undefined && parsed.name !== MEMORY_DOMAIN_NAME) ||
    (parsed.version !== undefined && parsed.version !== MEMORY_DOMAIN_VERSION)
  ) {
    throw new OperationError(
      'MEMORY_UNAVAILABLE',
      `Memory store at ${storePath} has unexpected domain header (name=${String(parsed.name)}, version=${String(parsed.version)}); refusing to overwrite.`,
    )
  }

  for (const tableName of MEMORY_TABLE_NAMES) {
    const container = parsed[tableName]
    if (container !== undefined && !isPlainObject(container)) {
      throw new OperationError(
        'MEMORY_UNAVAILABLE',
        `Memory store at ${storePath} has invalid table container "${tableName}"; refusing to overwrite.`,
      )
    }
    if (container !== undefined) {
      rawTables[tableName] = container
    }
  }

  return {
    format: 'agy-flat',
    rawTables,
  }
}

/**
 * Serialize table records back into the target outer JSON envelope losslessly.
 */
export function serializeStoreEnvelope(
  format: StoreEnvelopeFormat,
  tables: Record<MemoryTableName, Record<string, unknown>>,
  meta?: { unit?: Record<string, unknown> | undefined; global?: unknown },
): Buffer {
  const orderedTables: Record<MemoryTableName, Record<string, unknown>> = {
    memories: tables.memories ?? {},
    episodes: tables.episodes ?? {},
    dreams: tables.dreams ?? {},
    audit: tables.audit ?? {},
    operations: tables.operations ?? {},
    session_cursors: tables.session_cursors ?? {},
  }

  if (format === 'dsh-unit') {
    const unit: Record<string, unknown> = {
      name: MEMORY_DOMAIN_NAME,
      version: MEMORY_DOMAIN_VERSION,
      ...(meta?.unit ?? {}),
    }
    unit.name = MEMORY_DOMAIN_NAME
    unit.version = MEMORY_DOMAIN_VERSION

    const globalValue =
      meta !== undefined && 'global' in meta && meta.global !== undefined ? meta.global : null

    return Buffer.from(
      JSON.stringify(
        {
          unit,
          global: globalValue,
          tables: orderedTables,
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  return Buffer.from(
    JSON.stringify(
      {
        name: MEMORY_DOMAIN_NAME,
        version: MEMORY_DOMAIN_VERSION,
        ...orderedTables,
      },
      null,
      2,
    ),
    'utf8',
  )
}
