/**
 * Windows platform adapter: DSH process detection and default store discovery.
 * @module memloom/desktop/platform/win32
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveAgyDataPaths } from '../../agy/paths.ts'
import type {
  AgyDiscoveryResult,
  DiscoveredStore,
  DshProcessProbeResult,
  PlatformAdapter,
} from './types.ts'

const DEFAULT_PROBE_TIMEOUT_MS = 4000
const DSH_DESKTOP_EXE_LOWER = 'deepseek harness.exe'
const DSH_NODE_CMD_MARKERS = ['deepseek harness', 'dsh-runtimes', 'dsh-host'] as const

const POWERSHELL_PROBE_COMMAND =
  "Get-CimInstance Win32_Process -Filter 'Name=''DeepSeek Harness.exe'' OR Name=''node.exe''' | Select-Object Name, ProcessId, CommandLine | ConvertTo-Json -Compress"

/** Function signature for running the Windows process probe command. */
export interface Win32ProbeCommandRunner {
  (timeoutMs: number): Promise<string>
}

interface RawWin32Process {
  Name?: unknown
  name?: unknown
  ProcessId?: unknown
  processId?: unknown
  pid?: unknown
  CommandLine?: unknown
  commandLine?: unknown
}

function defaultRunProbe(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        POWERSHELL_PROBE_COMMAND,
      ],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

function readStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readPidField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatMatchedProcess(name: string, pid: number | undefined): string {
  return pid !== undefined ? `${name} (PID ${pid})` : name
}

function isMatchedWin32Process(entry: RawWin32Process): string | null {
  const name = readStringField(entry.Name ?? entry.name)
  if (name === undefined) return null

  const pid = readPidField(entry.ProcessId ?? entry.processId ?? entry.pid)
  const nameLower = name.toLowerCase()

  if (nameLower === DSH_DESKTOP_EXE_LOWER) {
    return formatMatchedProcess(name, pid)
  }

  if (nameLower === 'node.exe') {
    const commandLine = readStringField(entry.CommandLine ?? entry.commandLine)
    if (commandLine === undefined) return null
    const cmdLower = commandLine.toLowerCase()
    if (DSH_NODE_CMD_MARKERS.some((marker) => cmdLower.includes(marker))) {
      return formatMatchedProcess(name, pid)
    }
  }

  return null
}

/**
 * Parse JSON output from `Get-CimInstance Win32_Process ... | ConvertTo-Json`.
 * Fails closed (`uncertain: true`) on malformed JSON or unexpected payload shapes.
 */
export function parseWin32ProcessOutput(rawJson: string): DshProcessProbeResult {
  const trimmed = rawJson.trim()
  if (trimmed.length === 0 || trimmed === 'null') {
    return { running: false, uncertain: false, matchedProcesses: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      running: false,
      uncertain: true,
      matchedProcesses: [],
      error: `Failed to parse Windows process probe output: ${message}`,
    }
  }

  if (parsed === null) {
    return { running: false, uncertain: false, matchedProcesses: [] }
  }

  let items: unknown[]
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (typeof parsed === 'object') {
    items = [parsed]
  } else {
    return {
      running: false,
      uncertain: true,
      matchedProcesses: [],
      error: `Unexpected Windows process probe output type: ${typeof parsed}`,
    }
  }

  const matchedProcesses: string[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const matched = isMatchedWin32Process(item as RawWin32Process)
    if (matched !== null) {
      matchedProcesses.push(matched)
    }
  }

  return {
    running: matchedProcesses.length > 0,
    uncertain: false,
    matchedProcesses,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function hasAgyEnvOverride(env: NodeJS.ProcessEnv): boolean {
  return (
    nonEmptyEnv(env.MEMLOOM_STORE_PATH) !== undefined ||
    nonEmptyEnv(env.DSH_MEMORY_STORE_PATH) !== undefined ||
    nonEmptyEnv(env.MEMLOOM_DATA_DIR) !== undefined ||
    nonEmptyEnv(env.DSH_MEMORY_DATA_DIR) !== undefined ||
    nonEmptyEnv(env.PLUGIN_DATA) !== undefined
  )
}

/**
 * Shared DSH default & profile store discovery helper.
 * Resolves `$DSH_HOME/storages/memory.json` (or `<homeDir>/.dsh/storages/memory.json`)
 * plus any existing `profiles/<name>/storages/memory.json` entries.
 */
export async function discoverDefaultDshStores(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredStore[]> {
  const dshHomeOverride = nonEmptyEnv(env.DSH_HOME)
  const dshHome =
    dshHomeOverride !== undefined ? path.resolve(dshHomeOverride) : path.join(homeDir, '.dsh')

  const stores: DiscoveredStore[] = [
    {
      id: 'dsh-default',
      name: 'DSH (Default)',
      kind: 'dsh',
      storePath: path.join(dshHome, 'storages', 'memory.json'),
    },
  ]

  const profilesDir = path.join(dshHome, 'profiles')
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await fs.readdir(profilesDir, { withFileTypes: true })
  } catch {
    return stores
  }

  const profileStores: DiscoveredStore[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const profileName = entry.name
    const candidatePath = path.join(profilesDir, profileName, 'storages', 'memory.json')
    if (await fileExists(candidatePath)) {
      profileStores.push({
        id: `dsh-profile-${profileName}`,
        name: `DSH (${profileName})`,
        kind: 'dsh',
        storePath: candidatePath,
        profileName,
      })
    }
  }

  profileStores.sort((a, b) => a.name.localeCompare(b.name))
  return [...stores, ...profileStores]
}

/**
 * Shared AGY default store discovery helper.
 * Exposes `legacyCandidatePath` when the primary store is missing and the legacy
 * `dsh-memory` store file exists.
 */
export async function discoverDefaultAgyStore(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgyDiscoveryResult> {
  const agyPaths = hasAgyEnvOverride(env)
    ? resolveAgyDataPaths(env)
    : resolveAgyDataPaths({
        ...env,
        MEMLOOM_DATA_DIR: path.join(homeDir, '.gemini', 'config', 'plugin-data', 'memloom'),
      })

  const primary: DiscoveredStore = {
    id: 'agy-default',
    name: 'AGY (Default)',
    kind: 'agy',
    storePath: agyPaths.storePath,
  }

  const primaryExists = await fileExists(primary.storePath)
  if (primaryExists) {
    return { primary }
  }

  const legacyPath = path.join(
    homeDir,
    '.gemini',
    'config',
    'plugin-data',
    'dsh-memory',
    'memory.json',
  )
  if (
    path.resolve(legacyPath) !== path.resolve(primary.storePath) &&
    (await fileExists(legacyPath))
  ) {
    return { primary, legacyCandidatePath: legacyPath }
  }

  return { primary }
}

/** Create the Windows {@link PlatformAdapter} implementation. */
export function createWin32PlatformAdapter(options?: {
  homeDir?: string
  runProbe?: Win32ProbeCommandRunner
  probeTimeoutMs?: number
}): PlatformAdapter {
  const homeDir = options?.homeDir ?? os.homedir()
  const runProbe = options?.runProbe ?? defaultRunProbe
  const probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  return {
    platform: 'win32',
    async detectDshProcesses(): Promise<DshProcessProbeResult> {
      try {
        const raw = await runProbe(probeTimeoutMs)
        return parseWin32ProcessOutput(raw)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          running: false,
          uncertain: true,
          matchedProcesses: [],
          error: message,
        }
      }
    },
    resolveDefaultDshStores(env?: NodeJS.ProcessEnv): Promise<DiscoveredStore[]> {
      return discoverDefaultDshStores(homeDir, env)
    },
    resolveDefaultAgyStore(env?: NodeJS.ProcessEnv): Promise<AgyDiscoveryResult> {
      return discoverDefaultAgyStore(homeDir, env)
    },
  }
}
