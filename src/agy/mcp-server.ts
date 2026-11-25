/**
 * AGY Stdio MCP Server entrypoint.
 *
 * Wires {@link FileMemoryDomain}, {@link AgyConfigStore},
 * {@link AgySessionStateStore}, {@link MemoryEngine}, the 20 tiered AGY MCP
 * tools, startup crash recovery, and periodic 6-hour retention onto
 * {@link StdioMcpServer}.
 * @module dsh-memory/agy/mcp-server
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryEngine } from '../core/engine.ts'
import { AgyConfigStore } from './config-store.ts'
import { StdioMcpServer } from './mcp-protocol.ts'
import { resolveAgyDataPaths } from './paths.ts'
import { AgySessionStateStore } from './session-state.ts'
import { FileMemoryDomain } from './storage.ts'
import { createAgyTools } from './tools.ts'
import { resolveCallContext } from './workspace-resolver.ts'

const SERVER_NAME = 'dsh-memory'
const SERVER_VERSION = '0.1.3'
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000
const SESSION_RETENTION_DAYS = 30

/** Optional stream and timer overrides for programmatic testing. */
export interface StartAgyMcpServerOptions {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  retentionIntervalMs?: number
}

/**
 * Open AGY storage, run locked startup recovery, start the Stdio MCP server,
 * and schedule unref'd 6-hour retention + session cleanup.
 */
export async function startAgyMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  options?: StartAgyMcpServerOptions,
): Promise<{ stop(): Promise<void> }> {
  const paths = resolveAgyDataPaths(env)
  const stderr = options?.stderr ?? process.stderr

  const logStderr = (message: string): void => {
    try {
      stderr.write(`[dsh-memory] ${message}\n`)
    } catch {
      // Ignore diagnostic stream errors.
    }
  }

  const configStore = new AgyConfigStore(paths.configPath)
  const sessionStore = new AgySessionStateStore(paths.sessionsDir)
  const initialConfig = await configStore.load()

  const engineHolder: { current?: MemoryEngine } = {}
  const domain = await FileMemoryDomain.open({
    storePath: paths.storePath,
    lockPath: paths.lockPath,
    backupsDir: paths.backupsDir,
    onReload: () => {
      engineHolder.current?.syncSearchIndex()
    },
    onWarn: logStderr,
  })

  const engine = new MemoryEngine({
    domain,
    config: initialConfig,
    logger: { warn: logStderr },
  })
  engineHolder.current = engine

  await domain.withWriteLock(async () => {
    await engine.recover()
  })

  const tools = createAgyTools({
    domain,
    engine,
    configStore,
    sessionStore,
    dataDir: paths.dataDir,
  })

  const server = new StdioMcpServer({
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    tools,
    resolveContext: (args, listRoots) =>
      resolveCallContext({
        args,
        dataDir: paths.dataDir,
        sessionStore,
        ...(listRoots === undefined ? {} : { listRoots }),
      }),
    ...(options?.input === undefined ? {} : { input: options.input }),
    ...(options?.output === undefined ? {} : { output: options.output }),
    stderr,
  })

  let retentionRunning = false
  const retentionIntervalMs = options?.retentionIntervalMs ?? RETENTION_INTERVAL_MS
  const retentionTimer = setInterval(() => {
    if (retentionRunning) return
    retentionRunning = true
    void (async () => {
      try {
        const cfg = await configStore.syncIfChanged()
        if (cfg.changed) {
          engine.updateConfig(cfg.config)
        }
        await domain.withWriteLock(async () => {
          await engine.runRetention()
        })
        await sessionStore.pruneExpired(SESSION_RETENTION_DAYS)
      } catch (err) {
        logStderr(`periodic retention failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        retentionRunning = false
      }
    })()
  }, retentionIntervalMs)
  retentionTimer.unref()

  server.start()

  let stopPromise: Promise<void> | undefined
  return {
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise
      stopPromise = (async () => {
        clearInterval(retentionTimer)
        await server.stop()
        await domain.close()
      })()
      return stopPromise
    },
  }
}

function sameFileUrl(candidatePath: string, moduleUrl: string): boolean {
  const candidateUrl = pathToFileURL(candidatePath).href
  if (candidateUrl === moduleUrl) return true
  if (process.platform === 'win32' && candidateUrl.toLowerCase() === moduleUrl.toLowerCase()) {
    return true
  }
  return false
}

function isDirectEntrypoint(): boolean {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try {
    const resolved = path.resolve(entry)
    if (sameFileUrl(resolved, import.meta.url)) return true
    const real = realpathSync(resolved)
    return sameFileUrl(real, import.meta.url)
  } catch {
    return false
  }
}

if (isDirectEntrypoint()) {
  void startAgyMcpServer()
    .then((handle) => {
      let shuttingDown = false
      const shutdown = () => {
        if (shuttingDown) return
        shuttingDown = true
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
        void handle.stop().finally(() => {
          process.exit(0)
        })
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((err) => {
      process.stderr.write(
        `[dsh-memory] failed to start MCP server: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    })
}
