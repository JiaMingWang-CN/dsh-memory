/**
 * Cross-host plugin lifecycle manager (AGY + DSH) for Memloom Desktop.
 *
 * Enforces a single process-wide exclusive lock across plugin mutations and
 * updater tasks, protects AGY symlinks & multi-plugin host JSON configs,
 * enforces fail-closed DSH running checks, and safely wraps Node 24 Windows
 * `.cmd` shims against quoting bugs and metacharacter injection.
 * @module memloom/desktop/plugin-manager
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveAgyDataPaths } from '../agy/paths.ts'
import { writeFileAtomic } from '../agy/storage.ts'
import {
  isSafeRelativePath,
  verifyBundledAgyFiles,
  type ResolvedBundledPlugins,
} from './bundled-plugins.ts'
import type { HostPluginStatus, PlatformAdapter } from './platform/types.ts'
import { probeAgyPluginStatus, probeDshPluginStatus } from './platform/win32.ts'
import type { ClientRegistry, PendingPluginSyncTarget } from './registry.ts'

const KNOWN_PLUGIN_NAMES = new Set(['memloom', 'dsh-memory'])
const ALLOWED_DSH_CLI_BASENAMES = new Set(['dsh', 'dsh.exe', 'dsh.cmd'])
const SAFE_PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/
const CMD_METACHAR_RE = /[&|<>^%"\r\n]/
const DSH_CLI_TIMEOUT_MS = 120_000

export class DesktopBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopBusyError'
  }
}

export class DesktopDshRunningError extends Error {
  readonly matchedProcesses: readonly string[]

  constructor(message: string, matchedProcesses: readonly string[]) {
    super(message)
    this.name = 'DesktopDshRunningError'
    this.matchedProcesses = [...matchedProcesses]
  }
}

export class DesktopDshCliMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesktopDshCliMissingError'
  }
}

export class DesktopPluginOpError extends Error {
  readonly details?: Record<string, unknown>

  constructor(message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'DesktopPluginOpError'
    if (details !== undefined) {
      this.details = details
    }
  }
}

export interface DshProfileSummary {
  readonly name: string
  readonly pluginStatus: HostPluginStatus
}

export interface PluginOpResult {
  readonly kind: 'agy' | 'dsh'
  readonly action: 'install' | 'uninstall'
  readonly profileName?: string
  readonly version?: string
  readonly installPath?: string
  readonly pluginStatus: HostPluginStatus
  readonly restartRequired: boolean
  readonly warnings: readonly string[]
}

export interface DshExecRunnerOptions {
  readonly windowsVerbatimArguments?: boolean
  readonly windowsHide?: boolean
  readonly timeout?: number
}

export interface DesktopPluginManagerOptions {
  readonly registry: ClientRegistry
  readonly platform: PlatformAdapter
  readonly homeDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly hostPlatform?: NodeJS.Platform
  readonly trustedArtifactRoots: readonly string[]
  readonly resolveBundled?: () => Promise<ResolvedBundledPlugins | null>
  readonly execFileRunner?: (
    file: string,
    args: readonly string[],
    options: DshExecRunnerOptions,
  ) => Promise<{ stdout: string; stderr: string }>
  readonly renameImpl?: (oldPath: string, newPath: string) => Promise<void>
}

/** Check whether a file path has an allowlisted DSH CLI executable basename (`dsh`, `dsh.exe`, `dsh.cmd`). */
export function isAllowedDshCliBasename(filePath: string): boolean {
  const trimmed = filePath.trim()
  if (trimmed.length === 0) return false
  const base = path.win32.basename(trimmed).toLowerCase()
  return ALLOWED_DSH_CLI_BASENAMES.has(base)
}

/** Validate a DSH profile name against a strict character allowlist. */
export function validateSafeDshProfileName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && SAFE_PROFILE_NAME_RE.test(name)
}

function defaultExecFileRunner(
  file: string,
  args: readonly string[],
  options: DshExecRunnerOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        windowsHide: options.windowsHide ?? true,
        ...(options.windowsVerbatimArguments !== undefined
          ? { windowsVerbatimArguments: options.windowsVerbatimArguments }
          : {}),
        timeout: options.timeout ?? DSH_CLI_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message
          reject(new Error(`Command failed (${file}): ${detail}`))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

async function readJsonStrict(
  filePath: string,
): Promise<{ exists: false } | { exists: true; value: unknown }> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      return { exists: false }
    }
    throw new DesktopPluginOpError(
      `Failed to read host config ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { path: filePath },
    )
  }

  try {
    return { exists: true, value: JSON.parse(raw) as unknown }
  } catch (err) {
    throw new DesktopPluginOpError(
      `Host config ${filePath} contains corrupted JSON. Please repair it before modifying plugins: ${err instanceof Error ? err.message : String(err)}`,
      { path: filePath, reason: 'corrupt-json' },
    )
  }
}

async function readPluginJsonNameAndVersion(
  dirPath: string,
): Promise<{ name: string; version?: string } | null> {
  try {
    const raw = await fs.readFile(path.join(dirPath, 'plugin.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    if (name.length === 0) return null
    const version =
      typeof parsed.version === 'string' && parsed.version.trim().length > 0
        ? parsed.version.trim()
        : undefined
    return { name, ...(version !== undefined ? { version } : {}) }
  } catch {
    return null
  }
}

async function collectRelativeFiles(baseDir: string, currentDir = baseDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectRelativeFiles(baseDir, full)))
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, full).split(path.sep).join('/'))
    }
  }
  return out.sort()
}

function isPathInsideAnyRoot(
  targetPath: string,
  roots: readonly string[],
  hostPlatform: NodeJS.Platform,
): boolean {
  const resolvedTarget = path.resolve(targetPath)
  const normTarget = hostPlatform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget
  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    const normRoot = hostPlatform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
    const rel = path.relative(normRoot, normTarget)
    if (rel.length === 0 || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true
    }
  }
  return false
}

export class DesktopPluginManager {
  private readonly registry: ClientRegistry
  private readonly platform: PlatformAdapter
  private readonly homeDir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly hostPlatform: NodeJS.Platform
  private readonly trustedArtifactRoots: readonly string[]
  private readonly resolveBundled?: () => Promise<ResolvedBundledPlugins | null>
  private readonly execFileRunner: (
    file: string,
    args: readonly string[],
    options: DshExecRunnerOptions,
  ) => Promise<{ stdout: string; stderr: string }>
  private readonly renameImpl: (oldPath: string, newPath: string) => Promise<void>

  private busyLabel: string | null = null
  private busyToken: symbol | null = null
  private readonly lockContext = new AsyncLocalStorage<symbol>()

  constructor(options: DesktopPluginManagerOptions) {
    this.registry = options.registry
    this.platform = options.platform
    this.homeDir = options.homeDir ?? os.homedir()
    this.env = options.env ?? process.env
    this.hostPlatform = options.hostPlatform ?? process.platform
    this.trustedArtifactRoots = options.trustedArtifactRoots.map((root) => path.resolve(root))
    if (options.resolveBundled !== undefined) {
      this.resolveBundled = options.resolveBundled
    }
    this.execFileRunner = options.execFileRunner ?? defaultExecFileRunner
    this.renameImpl = options.renameImpl ?? ((oldPath, newPath) => fs.rename(oldPath, newPath))
  }

  /** Return whether an exclusive plugin or updater operation is currently running. */
  isBusy(): boolean {
    return this.busyLabel !== null
  }

  /** Execute an async operation under the single process-wide exclusive lock. */
  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const activeToken = this.lockContext.getStore()
    if (this.busyToken !== null && activeToken === this.busyToken) {
      return fn()
    }
    if (this.busyLabel !== null) {
      throw new DesktopBusyError(
        `Another operation (${this.busyLabel}) is already in progress. Please wait until it finishes.`,
      )
    }
    const token = Symbol(label)
    this.busyLabel = label
    this.busyToken = token
    try {
      return await this.lockContext.run(token, fn)
    } finally {
      this.busyLabel = null
      this.busyToken = null
    }
  }

  private resolveDshHome(): string {
    const override = this.env.DSH_HOME?.trim()
    return override !== undefined && override.length > 0
      ? path.resolve(override)
      : path.join(this.homeDir, '.dsh')
  }

  private resolveAgyStorePath(): string {
    const agyPaths = resolveAgyDataPaths({
      ...this.env,
      MEMLOOM_DATA_DIR:
        this.env.MEMLOOM_DATA_DIR?.trim() ||
        path.join(this.homeDir, '.gemini', 'config', 'plugin-data', 'memloom'),
    })
    return agyPaths.storePath
  }

  /** Enumerate all local DSH profiles under `$DSH_HOME/profiles/` with `desktop` first. */
  async listDshProfiles(): Promise<DshProfileSummary[]> {
    const dshHome = this.resolveDshHome()
    const profilesDir = path.join(dshHome, 'profiles')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(profilesDir, { withFileTypes: true })
    } catch {
      return []
    }

    const names = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)))

    const summaries: DshProfileSummary[] = []
    for (const name of names) {
      const pluginStatus = await probeDshPluginStatus(dshHome, name)
      summaries.push({ name, pluginStatus })
    }
    return summaries
  }

  /** Collect all currently installed & enabled host targets for post-restart plugin sync. */
  async collectEnabledInstalledSyncTargets(): Promise<PendingPluginSyncTarget[]> {
    const targets: PendingPluginSyncTarget[] = []

    const agyStatus = await probeAgyPluginStatus(this.homeDir, this.resolveAgyStorePath())
    if (agyStatus.installed && agyStatus.state === 'enabled') {
      targets.push({
        kind: 'agy',
        ...(agyStatus.version !== undefined ? { previousVersion: agyStatus.version } : {}),
        status: 'pending',
      })
    }

    const dshProfiles = await this.listDshProfiles()
    for (const profile of dshProfiles) {
      if (profile.pluginStatus.installed && profile.pluginStatus.state === 'enabled') {
        targets.push({
          kind: 'dsh',
          profileName: profile.name,
          ...(profile.pluginStatus.version !== undefined
            ? { previousVersion: profile.pluginStatus.version }
            : {}),
          status: 'pending',
        })
      }
    }

    return targets
  }

  /** Install or upgrade a host plugin from the bundled plugins payload. */
  async installBundled(req: {
    readonly kind: 'agy' | 'dsh'
    readonly profileName?: string
  }): Promise<PluginOpResult> {
    return this.runExclusive(`install-bundled:${req.kind}`, async () => {
      const bundled = this.resolveBundled !== undefined ? await this.resolveBundled() : null
      if (bundled === null) {
        throw new DesktopPluginOpError('Bundled plugins payload is not available.')
      }

      if (req.kind === 'agy') {
        const files = await verifyBundledAgyFiles(bundled)
        return this.installAgyInternal({
          sourceDir: bundled.agyDir,
          fileList: files,
        })
      }

      return this.installDshInternal({
        profileName: req.profileName ?? 'desktop',
        tgzPath: bundled.dshTgzPath,
        expectedVersion: bundled.manifest.version,
      })
    })
  }

  /** Install or upgrade a host plugin from a validated local directory or tarball. */
  async installFromLocal(req: {
    readonly kind: 'agy' | 'dsh'
    readonly profileName?: string
    readonly agySourceDir?: string
    readonly agyFileList?: readonly string[]
    readonly dshTgzPath?: string
    readonly preserveDisabledState?: boolean
  }): Promise<PluginOpResult> {
    return this.runExclusive(`install-local:${req.kind}`, async () => {
      if (req.kind === 'agy') {
        if (req.agySourceDir === undefined || req.agySourceDir.trim().length === 0) {
          throw new DesktopPluginOpError('Missing agySourceDir for AGY installation.')
        }
        return this.installAgyInternal({
          sourceDir: req.agySourceDir,
          ...(req.agyFileList !== undefined ? { fileList: req.agyFileList } : {}),
          ...(req.preserveDisabledState !== undefined
            ? { preserveDisabledState: req.preserveDisabledState }
            : {}),
        })
      }

      if (req.dshTgzPath === undefined || req.dshTgzPath.trim().length === 0) {
        throw new DesktopPluginOpError('Missing dshTgzPath for DSH installation.')
      }
      return this.installDshInternal({
        profileName: req.profileName ?? 'desktop',
        tgzPath: req.dshTgzPath,
      })
    })
  }

  /** Uninstall the Memloom / legacy `dsh-memory` plugin from AGY or a DSH profile. */
  async uninstall(req: {
    readonly kind: 'agy' | 'dsh'
    readonly profileName?: string
  }): Promise<PluginOpResult> {
    return this.runExclusive(`uninstall:${req.kind}`, async () => {
      if (req.kind === 'agy') {
        return this.uninstallAgyInternal()
      }
      return this.uninstallDshInternal(req.profileName ?? 'desktop')
    })
  }

  /**
   * Synchronize a list of pending host targets using the verified bundled plugins payload.
   * Disabled DSH profiles are skipped without invoking `dsh plugin add`.
   */
  async syncTargetsWithBundled(
    targets: readonly PendingPluginSyncTarget[],
    bundled: ResolvedBundledPlugins,
  ): Promise<PendingPluginSyncTarget[]> {
    const results: PendingPluginSyncTarget[] = []
    let verifiedAgyFiles: readonly string[] | undefined

    for (const target of targets) {
      if (target.status === 'succeeded' || target.status === 'skipped-disabled') {
        results.push({ ...target })
        continue
      }

      if (target.kind === 'agy') {
        try {
          verifiedAgyFiles ??= await verifyBundledAgyFiles(bundled)
          await this.installAgyInternal({
            sourceDir: bundled.agyDir,
            fileList: verifiedAgyFiles,
            preserveDisabledState: true,
          })
          results.push({
            kind: 'agy',
            ...(target.previousVersion !== undefined
              ? { previousVersion: target.previousVersion }
              : {}),
            status: 'succeeded',
          })
        } catch (err) {
          results.push({
            kind: 'agy',
            ...(target.previousVersion !== undefined
              ? { previousVersion: target.previousVersion }
              : {}),
            status: 'failed',
            errorCode: 'desktop/plugin-op-failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
        continue
      }

      const profileName = target.profileName ?? 'desktop'
      const dshHome = this.resolveDshHome()
      const currentStatus = await probeDshPluginStatus(dshHome, profileName)
      if (currentStatus.installed && currentStatus.state === 'disabled') {
        results.push({
          kind: 'dsh',
          profileName,
          ...(target.previousVersion !== undefined
            ? { previousVersion: target.previousVersion }
            : {}),
          status: 'skipped-disabled',
        })
        continue
      }

      try {
        await this.installDshInternal({
          profileName,
          tgzPath: bundled.dshTgzPath,
          expectedVersion: bundled.manifest.version,
        })
        results.push({
          kind: 'dsh',
          profileName,
          ...(target.previousVersion !== undefined
            ? { previousVersion: target.previousVersion }
            : {}),
          status: 'succeeded',
        })
      } catch (err) {
        if (err instanceof DesktopDshRunningError) {
          results.push({
            kind: 'dsh',
            profileName,
            ...(target.previousVersion !== undefined
              ? { previousVersion: target.previousVersion }
              : {}),
            status: 'blocked-dsh-running',
            errorCode: 'desktop/dsh-running',
            errorMessage: err.message,
          })
        } else if (err instanceof DesktopDshCliMissingError) {
          results.push({
            kind: 'dsh',
            profileName,
            ...(target.previousVersion !== undefined
              ? { previousVersion: target.previousVersion }
              : {}),
            status: 'failed',
            errorCode: 'desktop/dsh-cli-missing',
            errorMessage: err.message,
          })
        } else {
          results.push({
            kind: 'dsh',
            profileName,
            ...(target.previousVersion !== undefined
              ? { previousVersion: target.previousVersion }
              : {}),
            status: 'failed',
            errorCode: 'desktop/plugin-op-failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    await this.registry.refreshDiscovery()
    return results
  }

  private async ensureHostJsonReadable(geminiConfigDir: string): Promise<{
    configJson: { exists: false } | { exists: true; value: unknown }
    pluginsJson: { exists: false } | { exists: true; value: unknown }
  }> {
    const [configJson, pluginsJson] = await Promise.all([
      readJsonStrict(path.join(geminiConfigDir, 'config.json')),
      readJsonStrict(path.join(geminiConfigDir, 'plugins.json')),
    ])
    return { configJson, pluginsJson }
  }

  private async pruneMemloomFromPluginsJson(
    pluginsJsonPath: string,
    parsed: { exists: false } | { exists: true; value: unknown },
    warnings: string[],
  ): Promise<void> {
    if (!parsed.exists) return
    const val = parsed.value

    const isMemloomPathOrEntry = async (
      candidatePath: unknown,
      keyName?: string,
    ): Promise<boolean> => {
      if (keyName !== undefined && KNOWN_PLUGIN_NAMES.has(keyName)) {
        return true
      }
      if (typeof candidatePath === 'string' && candidatePath.trim().length > 0) {
        const meta = await readPluginJsonNameAndVersion(path.resolve(candidatePath))
        if (meta !== null && KNOWN_PLUGIN_NAMES.has(meta.name)) {
          return true
        }
      }
      return false
    }

    if (Array.isArray(val)) {
      const kept: unknown[] = []
      let removed = false
      for (const item of val) {
        let match = false
        if (typeof item === 'string') {
          match = await isMemloomPathOrEntry(item)
        } else if (item !== null && typeof item === 'object') {
          const obj = item as Record<string, unknown>
          const itemName = typeof obj.name === 'string' ? obj.name : undefined
          match = await isMemloomPathOrEntry(obj.path ?? obj.dir, itemName)
        }
        if (match) {
          removed = true
        } else {
          kept.push(item)
        }
      }
      if (removed) {
        await writeFileAtomic(pluginsJsonPath, `${JSON.stringify(kept, null, 2)}\n`)
        warnings.push(
          'Removed legacy memloom reference from ~/.gemini/config/plugins.json; external source directory was preserved.',
        )
      }
      return
    }

    if (val !== null && typeof val === 'object') {
      const nextObj: Record<string, unknown> = {}
      let removed = false
      for (const [key, entry] of Object.entries(val as Record<string, unknown>)) {
        let match = false
        if (typeof entry === 'string') {
          match = await isMemloomPathOrEntry(entry, key)
        } else if (entry !== null && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>
          match = await isMemloomPathOrEntry(obj.path ?? obj.dir, key)
        } else if (KNOWN_PLUGIN_NAMES.has(key)) {
          match = true
        }
        if (match) {
          removed = true
        } else {
          nextObj[key] = entry
        }
      }
      if (removed) {
        await writeFileAtomic(pluginsJsonPath, `${JSON.stringify(nextObj, null, 2)}\n`)
        warnings.push(
          'Removed legacy memloom reference from ~/.gemini/config/plugins.json; external source directory was preserved.',
        )
      }
    }
  }

  private async installAgyInternal(options: {
    readonly sourceDir: string
    readonly fileList?: readonly string[]
    readonly preserveDisabledState?: boolean
  }): Promise<PluginOpResult> {
    const warnings: string[] = []
    const geminiConfigDir = path.join(this.homeDir, '.gemini', 'config')
    const pluginsRoot = path.join(geminiConfigDir, 'plugins')
    const targetDir = path.join(pluginsRoot, 'memloom')

    // Fail-closed if host config.json or plugins.json is corrupted
    const { configJson, pluginsJson } = await this.ensureHostJsonReadable(geminiConfigDir)

    const beforeStatus = await probeAgyPluginStatus(this.homeDir, this.resolveAgyStorePath())
    const wasInstalled = beforeStatus.installed

    // Verify source plugin.json before touching target
    const sourceMeta = await readPluginJsonNameAndVersion(options.sourceDir)
    if (sourceMeta === null || sourceMeta.name !== 'memloom') {
      throw new DesktopPluginOpError(
        `Invalid AGY plugin source at ${options.sourceDir}: plugin.json must declare name "memloom".`,
      )
    }

    const files =
      options.fileList !== undefined
        ? [...options.fileList].sort()
        : await collectRelativeFiles(options.sourceDir)
    if (!files.includes('plugin.json')) {
      throw new DesktopPluginOpError('AGY plugin source is missing plugin.json.')
    }

    await fs.mkdir(pluginsRoot, { recursive: true })
    const stagingDir = path.join(pluginsRoot, `.memloom-staging-${randomUUID().slice(0, 8)}`)
    const backupDir = path.join(pluginsRoot, `.memloom-backup-${randomUUID().slice(0, 8)}`)
    let movedToBackup = false

    try {
      await fs.mkdir(stagingDir, { recursive: true })
      for (const rel of files) {
        if (!isSafeRelativePath(rel, false)) {
          throw new DesktopPluginOpError(`Unsafe file path in AGY plugin source: ${rel}`)
        }
        const srcFile = path.resolve(options.sourceDir, ...rel.split('/'))
        const dstFile = path.resolve(stagingDir, ...rel.split('/'))
        await fs.mkdir(path.dirname(dstFile), { recursive: true })
        await fs.copyFile(srcFile, dstFile)
      }

      // Check existing targetDir with lstat (symlink protection)
      let targetLstat: import('node:fs').Stats | null = null
      try {
        targetLstat = await fs.lstat(targetDir)
      } catch (err) {
        if (!isErrno(err, 'ENOENT')) throw err
      }

      if (targetLstat !== null) {
        if (targetLstat.isSymbolicLink()) {
          await fs.unlink(targetDir)
          warnings.push(
            'Replaced symbolic link at ~/.gemini/config/plugins/memloom; original link target directory was preserved.',
          )
        } else {
          await this.renameImpl(targetDir, backupDir)
          movedToBackup = true
        }
      }

      await this.renameImpl(stagingDir, targetDir)

      if (movedToBackup) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      if (movedToBackup) {
        await this.renameImpl(backupDir, targetDir).catch(() => undefined)
      }
      if (err instanceof DesktopPluginOpError) throw err
      throw new DesktopPluginOpError(
        `Failed to install AGY plugin (close Antigravity and retry): ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Remove any other memloom / dsh-memory plugin directories under ~/.gemini/config/plugins
    try {
      const siblingEntries = await fs.readdir(pluginsRoot, { withFileTypes: true })
      for (const entry of siblingEntries) {
        if (
          entry.name === 'memloom' ||
          entry.name.startsWith('.memloom-staging-') ||
          entry.name.startsWith('.memloom-backup-')
        ) {
          continue
        }
        const candidatePath = path.join(pluginsRoot, entry.name)
        let candidateStat: import('node:fs').Stats
        try {
          candidateStat = await fs.lstat(candidatePath)
        } catch {
          continue
        }
        if (candidateStat.isSymbolicLink()) {
          const meta = await readPluginJsonNameAndVersion(candidatePath)
          if (
            KNOWN_PLUGIN_NAMES.has(entry.name) ||
            (meta !== null && KNOWN_PLUGIN_NAMES.has(meta.name))
          ) {
            await fs.unlink(candidatePath)
            warnings.push(
              `Unlinked duplicate symbolic link ${candidatePath}; original target directory was preserved.`,
            )
          }
        } else if (candidateStat.isDirectory()) {
          const meta = await readPluginJsonNameAndVersion(candidatePath)
          if (meta !== null && KNOWN_PLUGIN_NAMES.has(meta.name)) {
            await fs.rm(candidatePath, { recursive: true, force: true })
          }
        }
      }
    } catch {
      // Ignore cleanup failures for non-standard sibling entries.
    }

    // Prune memloom/dsh-memory entries from ~/.gemini/config/plugins.json (preserving other plugins)
    await this.pruneMemloomFromPluginsJson(
      path.join(geminiConfigDir, 'plugins.json'),
      pluginsJson,
      warnings,
    )

    // On fresh install, clear explicit host disablement in ~/.gemini/config/config.json
    if (!wasInstalled && options.preserveDisabledState !== true && configJson.exists) {
      const cfg = configJson.value
      if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) {
        const cfgObj = { ...(cfg as Record<string, unknown>) }
        const pluginsSection = cfgObj.plugins
        if (
          pluginsSection !== null &&
          typeof pluginsSection === 'object' &&
          !Array.isArray(pluginsSection)
        ) {
          const nextPlugins = { ...(pluginsSection as Record<string, unknown>) }
          const entry = nextPlugins.memloom
          if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const entryObj = { ...(entry as Record<string, unknown>) }
            if (entryObj.enabled === false || entryObj.disabled === true) {
              delete entryObj.disabled
              entryObj.enabled = true
              nextPlugins.memloom = entryObj
              cfgObj.plugins = nextPlugins
              await writeFileAtomic(
                path.join(geminiConfigDir, 'config.json'),
                `${JSON.stringify(cfgObj, null, 2)}\n`,
              )
            }
          }
        }
      }
    }

    await this.registry.refreshDiscovery()
    const pluginStatus = await probeAgyPluginStatus(this.homeDir, this.resolveAgyStorePath())
    return {
      kind: 'agy',
      action: 'install',
      ...(sourceMeta.version !== undefined ? { version: sourceMeta.version } : {}),
      installPath: targetDir,
      pluginStatus,
      restartRequired: true,
      warnings,
    }
  }

  private async uninstallAgyInternal(): Promise<PluginOpResult> {
    const warnings: string[] = []
    const geminiConfigDir = path.join(this.homeDir, '.gemini', 'config')
    const pluginsRoot = path.join(geminiConfigDir, 'plugins')

    // Fail-closed if plugins.json or config.json is corrupted
    const { pluginsJson } = await this.ensureHostJsonReadable(geminiConfigDir)

    try {
      const entries = await fs.readdir(pluginsRoot, { withFileTypes: true })
      for (const entry of entries) {
        const candidatePath = path.join(pluginsRoot, entry.name)
        let st: import('node:fs').Stats
        try {
          st = await fs.lstat(candidatePath)
        } catch {
          continue
        }

        if (st.isSymbolicLink()) {
          const meta = await readPluginJsonNameAndVersion(candidatePath)
          if (
            KNOWN_PLUGIN_NAMES.has(entry.name) ||
            (meta !== null && KNOWN_PLUGIN_NAMES.has(meta.name))
          ) {
            await fs.unlink(candidatePath)
            warnings.push(
              `Unlinked symbolic link ${candidatePath}; original target directory was preserved.`,
            )
          }
        } else if (st.isDirectory()) {
          const meta = await readPluginJsonNameAndVersion(candidatePath)
          if (meta !== null && KNOWN_PLUGIN_NAMES.has(meta.name)) {
            await fs.rm(candidatePath, { recursive: true, force: true })
          }
        }
      }
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) {
        throw new DesktopPluginOpError(
          `Failed to remove AGY plugin directory: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    await this.pruneMemloomFromPluginsJson(
      path.join(geminiConfigDir, 'plugins.json'),
      pluginsJson,
      warnings,
    )

    await this.registry.refreshDiscovery()
    const pluginStatus = await probeAgyPluginStatus(this.homeDir, this.resolveAgyStorePath())
    return {
      kind: 'agy',
      action: 'uninstall',
      pluginStatus,
      restartRequired: true,
      warnings,
    }
  }

  private async ensureDshNotRunning(): Promise<void> {
    const probe = await this.platform.detectDshProcesses()
    if (probe.running || probe.uncertain) {
      const reason = probe.running
        ? `DSH is currently running (${probe.matchedProcesses.join(', ')}). Please close DSH before modifying DSH plugins.`
        : `Unable to verify whether DSH is stopped (${probe.error ?? 'process probe uncertain'}). Please close DSH and retry.`
      throw new DesktopDshRunningError(reason, probe.matchedProcesses)
    }
  }

  private async resolveDshCliPath(): Promise<string> {
    // 1. User-configured dshCliPath (re-validated after reload)
    const configured = this.registry.getPreferences().dshCliPath?.trim()
    if (configured !== undefined && configured.length > 0) {
      const isAbs =
        path.isAbsolute(configured) ||
        (this.hostPlatform === 'win32' && path.win32.isAbsolute(configured))
      if (isAbs && isAllowedDshCliBasename(configured) && (await isRegularFile(configured))) {
        return configured
      }
    }

    // 2. Search PATH
    const rawPath = this.env.PATH ?? this.env.Path ?? ''
    const delimiter = this.hostPlatform === 'win32' ? ';' : ':'
    const candidates = this.hostPlatform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh'] : ['dsh']

    for (const dir of rawPath.split(delimiter)) {
      const trimmedDir = dir.trim()
      if (trimmedDir.length === 0) continue
      for (const candidate of candidates) {
        const full = path.join(trimmedDir, candidate)
        if (await isRegularFile(full)) {
          return full
        }
      }
    }

    throw new DesktopDshCliMissingError(
      'Could not locate the `dsh` CLI executable. Please select `dsh` / `dsh.cmd` / `dsh.exe` in settings.',
    )
  }

  private async invokeDshCli(cliPath: string, args: readonly string[]): Promise<void> {
    const isWinCmd = this.hostPlatform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)
    if (isWinCmd) {
      if (CMD_METACHAR_RE.test(cliPath)) {
        throw new DesktopPluginOpError(
          `Refusing to execute Windows batch shim with unsafe path characters: ${cliPath}`,
        )
      }
      for (const arg of args) {
        if (CMD_METACHAR_RE.test(arg)) {
          throw new DesktopPluginOpError(
            `Refusing to pass unsafe characters to Windows batch shim: ${arg}`,
          )
        }
      }
      const quotedArgs = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
      const cmdLine = `""${cliPath}" ${quotedArgs.join(' ')}"`
      const comSpec = this.env.ComSpec?.trim() || 'cmd.exe'
      await this.execFileRunner(comSpec, ['/d', '/s', '/c', cmdLine], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        timeout: DSH_CLI_TIMEOUT_MS,
      })
      return
    }

    await this.execFileRunner(cliPath, args, {
      windowsHide: true,
      timeout: DSH_CLI_TIMEOUT_MS,
    })
  }

  private async installDshInternal(options: {
    readonly profileName: string
    readonly tgzPath: string
    readonly expectedVersion?: string
  }): Promise<PluginOpResult> {
    const warnings: string[] = []
    if (!validateSafeDshProfileName(options.profileName)) {
      throw new DesktopPluginOpError(`Invalid DSH profile name: ${options.profileName}`)
    }

    await this.ensureDshNotRunning()

    const resolvedTgz = path.resolve(options.tgzPath)
    if (!isPathInsideAnyRoot(resolvedTgz, this.trustedArtifactRoots, this.hostPlatform)) {
      throw new DesktopPluginOpError(
        `Refusing to install DSH tarball outside trusted artifact directories: ${resolvedTgz}`,
      )
    }
    if (!(await isRegularFile(resolvedTgz))) {
      throw new DesktopPluginOpError(`DSH plugin tarball does not exist: ${resolvedTgz}`)
    }

    const cliPath = await this.resolveDshCliPath()
    const dshHome = this.resolveDshHome()
    const beforeStatus = await probeDshPluginStatus(dshHome, options.profileName)

    if (beforeStatus.installed && beforeStatus.pluginName === 'dsh-memory') {
      await this.invokeDshCli(cliPath, [
        'plugin',
        '--profile',
        options.profileName,
        'remove',
        'dsh-memory',
      ])
      warnings.push('Removed legacy `dsh-memory` package before installing `memloom`.')
    }

    try {
      await this.invokeDshCli(cliPath, [
        'plugin',
        '--profile',
        options.profileName,
        'add',
        resolvedTgz,
      ])
    } catch (err) {
      if (err instanceof DesktopPluginOpError) throw err
      throw new DesktopPluginOpError(
        `DSH plugin installation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await this.registry.refreshDiscovery()
    const pluginStatus = await probeDshPluginStatus(dshHome, options.profileName)
    const resolvedVersion = pluginStatus.version ?? options.expectedVersion
    return {
      kind: 'dsh',
      action: 'install',
      profileName: options.profileName,
      ...(resolvedVersion !== undefined ? { version: resolvedVersion } : {}),
      ...(pluginStatus.installPath !== undefined ? { installPath: pluginStatus.installPath } : {}),
      pluginStatus,
      restartRequired: true,
      warnings,
    }
  }

  private async uninstallDshInternal(profileName: string): Promise<PluginOpResult> {
    if (!validateSafeDshProfileName(profileName)) {
      throw new DesktopPluginOpError(`Invalid DSH profile name: ${profileName}`)
    }

    await this.ensureDshNotRunning()
    const cliPath = await this.resolveDshCliPath()
    const dshHome = this.resolveDshHome()
    const beforeStatus = await probeDshPluginStatus(dshHome, profileName)
    const pkgName = beforeStatus.pluginName ?? 'memloom'

    try {
      await this.invokeDshCli(cliPath, ['plugin', '--profile', profileName, 'remove', pkgName])
    } catch (err) {
      if (err instanceof DesktopPluginOpError) throw err
      throw new DesktopPluginOpError(
        `DSH plugin uninstallation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await this.registry.refreshDiscovery()
    const pluginStatus = await probeDshPluginStatus(dshHome, profileName)
    return {
      kind: 'dsh',
      action: 'uninstall',
      profileName,
      pluginStatus,
      restartRequired: true,
      warnings: [],
    }
  }
}
