/**
 * AGY plugin data directory and file path resolution.
 *
 * Resolves paths strictly in priority order:
 * `DSH_MEMORY_STORE_PATH` > `DSH_MEMORY_DATA_DIR` > `PLUGIN_DATA` >
 * `~/.gemini/config/plugin-data/dsh-memory`.
 * @module dsh-memory/agy/paths
 */
import os from 'node:os'
import path from 'node:path'

/** Resolved file-system paths used by the AGY adapter. */
export interface AgyDataPaths {
  readonly dataDir: string
  readonly storePath: string
  readonly lockPath: string
  readonly configPath: string
  readonly sessionsDir: string
  readonly backupsDir: string
  readonly logPath: string
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Resolve all AGY plugin storage, lock, config, session, backup and log paths.
 * @param env - Environment variables (defaults to `process.env`).
 * @returns Fully resolved {@link AgyDataPaths}.
 */
export function resolveAgyDataPaths(env: NodeJS.ProcessEnv = process.env): AgyDataPaths {
  const storeOverride = nonEmpty(env.DSH_MEMORY_STORE_PATH)
  let dataDir: string
  let storePath: string

  if (storeOverride !== undefined) {
    storePath = path.resolve(storeOverride)
    dataDir = path.dirname(storePath)
  } else {
    const dirOverride = nonEmpty(env.DSH_MEMORY_DATA_DIR) ?? nonEmpty(env.PLUGIN_DATA)
    dataDir =
      dirOverride !== undefined
        ? path.resolve(dirOverride)
        : path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'dsh-memory')
    storePath = path.join(dataDir, 'memory.json')
  }

  return {
    dataDir,
    storePath,
    lockPath: path.join(dataDir, '.memory.lock'),
    configPath: path.join(dataDir, 'config.json'),
    sessionsDir: path.join(dataDir, 'sessions'),
    backupsDir: path.join(dataDir, 'backups'),
    logPath: path.join(dataDir, 'logs', 'hook-errors.log'),
  }
}
