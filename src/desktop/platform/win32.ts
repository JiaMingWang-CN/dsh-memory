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
  HostPluginStatus,
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

const KNOWN_PLUGIN_NAMES = ['memloom', 'dsh-memory'] as const

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

interface CordisPatchEntry {
  id?: string
  name?: string
  disabled?: boolean
  configEnabled?: boolean
}

function parseCordisPatchEntries(rawYaml: string): CordisPatchEntry[] {
  const entries: CordisPatchEntry[] = []
  let current: CordisPatchEntry | undefined
  let inConfig = false
  let configIndent = 0

  for (const line of rawYaml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length

    if (indent === 0 && trimmed.startsWith('- ')) {
      current = {}
      entries.push(current)
      inConfig = false
      const rest = trimmed.slice(2).trim()
      const idMatch = /^id:\s*(.+)$/.exec(rest)
      if (idMatch?.[1] !== undefined) current.id = unquoteYamlScalar(idMatch[1])
      const nameMatch = /^name:\s*(.+)$/.exec(rest)
      if (nameMatch?.[1] !== undefined) current.name = unquoteYamlScalar(nameMatch[1])
      continue
    }

    if (current === undefined) continue
    if (indent <= 2) {
      inConfig = false
      const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
      if (nameMatch?.[1] !== undefined) {
        current.name = unquoteYamlScalar(nameMatch[1])
        continue
      }
      const idMatch = /^id:\s*(.+)$/.exec(trimmed)
      if (idMatch?.[1] !== undefined) {
        current.id = unquoteYamlScalar(idMatch[1])
        continue
      }
      const disabledMatch = /^disabled:\s*(true|false)\s*$/i.exec(trimmed)
      if (disabledMatch?.[1] !== undefined) {
        current.disabled = disabledMatch[1].toLowerCase() === 'true'
        continue
      }
      if (/^config:\s*$/.test(trimmed)) {
        inConfig = true
        configIndent = indent
      }
      continue
    }

    if (inConfig && indent > configIndent) {
      if (indent <= configIndent + 2) {
        const enabledMatch = /^enabled:\s*(true|false)\s*$/i.exec(trimmed)
        if (enabledMatch?.[1] !== undefined) {
          current.configEnabled = enabledMatch[1].toLowerCase() === 'true'
        }
      }
    } else if (indent <= configIndent) {
      inConfig = false
    }
  }
  return entries
}

async function probeDshProfileDirectory(profileDir: string): Promise<HostPluginStatus | undefined> {
  const pkgJson = await readJsonFile(path.join(profileDir, 'package.json'))
  if (pkgJson === undefined) return undefined

  const dshMeta =
    pkgJson.dsh !== null && typeof pkgJson.dsh === 'object'
      ? ((pkgJson.dsh as Record<string, unknown>).profile as Record<string, unknown> | undefined)
      : undefined
  const bundlesRaw = Array.isArray(dshMeta?.bundles) ? dshMeta.bundles : []
  const bundles = bundlesRaw.filter((item): item is string => typeof item === 'string')
  const deps =
    pkgJson.dependencies !== null && typeof pkgJson.dependencies === 'object'
      ? (pkgJson.dependencies as Record<string, unknown>)
      : {}

  let matchedPkg: string | undefined
  let version: string | undefined
  let installPath: string | undefined
  for (const candidate of KNOWN_PLUGIN_NAMES) {
    const modPath = path.join(profileDir, 'node_modules', candidate)
    const modPkg = await readJsonFile(path.join(modPath, 'package.json'))
    const inBundles = bundles.includes(candidate)
    const inDeps = typeof deps[candidate] === 'string'
    if (inBundles || inDeps || modPkg !== undefined) {
      matchedPkg = candidate
      if (typeof modPkg?.version === 'string' && modPkg.version.trim().length > 0) {
        version = modPkg.version.trim()
      }
      if (modPkg !== undefined) {
        installPath = modPath
      }
      break
    }
  }

  if (matchedPkg === undefined) return undefined

  const inBundles = bundles.includes(matchedPkg)
  let patchEntry: CordisPatchEntry | undefined
  try {
    const patchRaw = await fs.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
    const entries = parseCordisPatchEntries(patchRaw)
    patchEntry = entries.find(
      (entry) =>
        entry.name === matchedPkg ||
        entry.id === matchedPkg ||
        (matchedPkg === 'dsh-memory' && entry.id === 'dsh-memory'),
    )
  } catch {
    // Missing or unreadable cordis.patch.yml is treated as no override.
  }

  if (!inBundles) {
    return {
      state: 'disabled',
      installed: true,
      enabled: false,
      ...(version !== undefined ? { version } : {}),
      pluginName: matchedPkg,
      ...(installPath !== undefined ? { installPath } : {}),
      detail: 'Installed in dependencies but omitted from dsh.profile.bundles.',
    }
  }
  if (patchEntry?.disabled === true) {
    return {
      state: 'disabled',
      installed: true,
      enabled: false,
      ...(version !== undefined ? { version } : {}),
      pluginName: matchedPkg,
      ...(installPath !== undefined ? { installPath } : {}),
      detail: 'Disabled in cordis.patch.yml.',
    }
  }
  if (patchEntry?.configEnabled === false) {
    return {
      state: 'disabled',
      installed: true,
      enabled: false,
      ...(version !== undefined ? { version } : {}),
      pluginName: matchedPkg,
      ...(installPath !== undefined ? { installPath } : {}),
      detail: 'config.enabled is false in cordis.patch.yml.',
    }
  }

  return {
    state: 'enabled',
    installed: true,
    enabled: true,
    ...(version !== undefined ? { version } : {}),
    pluginName: matchedPkg,
    ...(installPath !== undefined ? { installPath } : {}),
  }
}

/**
 * Probe whether `memloom` / `dsh-memory` is installed and enabled in DSH profiles.
 */
export async function probeDshPluginStatus(
  dshHome: string,
  profileName?: string,
): Promise<HostPluginStatus> {
  const profilesDir = path.join(dshHome, 'profiles')
  const candidateDirs: string[] = []
  if (profileName !== undefined) {
    candidateDirs.push(path.join(profilesDir, profileName))
  } else {
    try {
      const entries = await fs.readdir(profilesDir, { withFileTypes: true })
      const names = entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)))
      for (const name of names) {
        candidateDirs.push(path.join(profilesDir, name))
      }
    } catch {
      return {
        state: 'not-installed',
        installed: false,
        enabled: false,
        detail: 'No DSH profiles directory found.',
      }
    }
  }

  for (const dir of candidateDirs) {
    const probed = await probeDshProfileDirectory(dir)
    if (probed !== undefined) return probed
  }

  return {
    state: 'not-installed',
    installed: false,
    enabled: false,
    detail: 'Plugin is not installed in DSH profile dependencies or bundles.',
  }
}

/**
 * Probe whether `memloom` is installed and enabled in Antigravity (AGY).
 */
export async function probeAgyPluginStatus(
  homeDir: string,
  storePath: string,
): Promise<HostPluginStatus> {
  const geminiConfigDir = path.join(homeDir, '.gemini', 'config')
  const pluginsRoot = path.join(geminiConfigDir, 'plugins')

  let installPath: string | undefined
  let dirName: string | undefined
  let pluginName: string | undefined
  let version: string | undefined

  const tryPluginDir = async (dir: string): Promise<boolean> => {
    const manifest = await readJsonFile(path.join(dir, 'plugin.json'))
    const rawName = typeof manifest?.name === 'string' ? manifest.name.trim() : ''
    if (rawName !== 'memloom' && rawName !== 'dsh-memory') return false
    installPath = dir
    dirName = path.basename(dir)
    pluginName = rawName
    if (typeof manifest?.version === 'string' && manifest.version.trim().length > 0) {
      version = manifest.version.trim()
    }
    return true
  }

  if (!(await tryPluginDir(path.join(pluginsRoot, 'memloom')))) {
    try {
      const entries = await fs.readdir(pluginsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (await tryPluginDir(path.join(pluginsRoot, entry.name))) break
      }
    } catch {
      // Fall through to plugins.json check.
    }
  }

  if (installPath === undefined) {
    try {
      const pluginsJsonRaw = await fs.readFile(path.join(geminiConfigDir, 'plugins.json'), 'utf8')
      const parsed: unknown = JSON.parse(pluginsJsonRaw)
      const candidates: string[] = []
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') candidates.push(item)
          else if (
            item !== null &&
            typeof item === 'object' &&
            typeof (item as { path?: unknown }).path === 'string'
          ) {
            candidates.push((item as { path: string }).path)
          }
        }
      } else if (parsed !== null && typeof parsed === 'object') {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val === 'string') candidates.push(val)
          else if (
            val !== null &&
            typeof val === 'object' &&
            typeof (val as { path?: unknown }).path === 'string'
          ) {
            candidates.push((val as { path: string }).path)
          } else if (key === 'memloom' && typeof (val as { dir?: unknown })?.dir === 'string') {
            candidates.push((val as { dir: string }).dir)
          }
        }
      }
      for (const candidate of candidates) {
        if (await tryPluginDir(path.resolve(candidate))) break
      }
    } catch {
      // No readable plugins.json fallback.
    }
  }

  if (installPath === undefined || pluginName === undefined || dirName === undefined) {
    return {
      state: 'not-installed',
      installed: false,
      enabled: false,
      detail: 'Plugin is not installed under ~/.gemini/config/plugins.',
    }
  }

  const hostConfig = await readJsonFile(path.join(geminiConfigDir, 'config.json'))
  const pluginsSection =
    hostConfig?.plugins !== null && typeof hostConfig?.plugins === 'object'
      ? (hostConfig.plugins as Record<string, unknown>)
      : undefined
  const hostEntry =
    (pluginsSection?.[dirName] as Record<string, unknown> | undefined) ??
    (pluginsSection?.[pluginName] as Record<string, unknown> | undefined)

  if (hostEntry?.enabled === false || hostEntry?.disabled === true) {
    return {
      state: 'disabled',
      installed: true,
      enabled: false,
      ...(version !== undefined ? { version } : {}),
      pluginName,
      installPath,
      detail: 'Disabled in AGY ~/.gemini/config/config.json.',
    }
  }

  const runtimeConfig = await readJsonFile(path.join(path.dirname(storePath), 'config.json'))
  if (runtimeConfig?.enabled === false) {
    return {
      state: 'disabled',
      installed: true,
      enabled: false,
      ...(version !== undefined ? { version } : {}),
      pluginName,
      installPath,
      detail: 'Runtime config.enabled is false in plugin data config.json.',
    }
  }

  return {
    state: 'enabled',
    installed: true,
    enabled: true,
    ...(version !== undefined ? { version } : {}),
    pluginName,
    installPath,
  }
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

  const defaultPluginStatus = await probeDshPluginStatus(dshHome)
  const stores: DiscoveredStore[] = [
    {
      id: 'dsh-default',
      name: 'DSH (Default)',
      kind: 'dsh',
      storePath: path.join(dshHome, 'storages', 'memory.json'),
      pluginStatus: defaultPluginStatus,
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
        pluginStatus: await probeDshPluginStatus(dshHome, profileName),
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

  const pluginStatus = await probeAgyPluginStatus(homeDir, agyPaths.storePath)
  const primary: DiscoveredStore = {
    id: 'agy-default',
    name: 'AGY (Default)',
    kind: 'agy',
    storePath: agyPaths.storePath,
    pluginStatus,
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
