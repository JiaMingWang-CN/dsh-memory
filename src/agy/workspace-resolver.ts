/**
 * Authoritative workspace resolution and anti-forgery runtime nonce for AGY.
 *
 * Resolves the caller's workspace in strict trust order:
 * 1. Verified `__agyHostContext` injected by `PreToolUse` (timing-safe nonce check)
 * 2. MCP `roots/list` `file://` URIs (most specific root wins)
 * 3. `AgySessionStateStore` anchor (trusted `conversationId` or unique recent workspace)
 * 4. `null` (strict global-only degradation)
 * @module memloom/agy/workspace-resolver
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeWorkspaceKey, type WorkspaceIdentity } from '../core/workspace.ts'
import type { AgySessionStateStore } from './session-state.ts'
import { readFileWithRetry } from './storage.ts'

/** Reserved internal argument key injected by AGY `PreToolUse` `overwrite`. */
export const HOST_CONTEXT_ARG_KEY = '__agyHostContext'

const RUNTIME_NONCE_FILENAME = '.runtime-nonce'
const NONCE_BYTES = 32
const NONCE_READ_RETRIES = 5
const NONCE_READ_RETRY_MS = 10

/** Trusted host metadata injected by `PreToolUse` and verified via shared nonce. */
export interface HostContextPayload {
  readonly workspaceRoot?: string
  readonly conversationId?: string
  readonly approvedScopeOverride?: boolean
  readonly nonce: string
}

/** Resolved authority context passed to every AGY MCP tool invocation. */
export interface ResolvedCallContext {
  readonly workspace: WorkspaceIdentity | null
  readonly conversationId?: string
  readonly trustedHost: boolean
  readonly approvedScopeOverride: boolean
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonceFilePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), RUNTIME_NONCE_FILENAME)
}

function isAbsoluteWorkspacePath(rawPath: string): boolean {
  return path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath)
}

function toWorkspaceIdentity(rawRoot: string | undefined): WorkspaceIdentity | null {
  if (typeof rawRoot !== 'string') return null
  const trimmed = rawRoot.trim()
  if (trimmed.length === 0 || !isAbsoluteWorkspacePath(trimmed)) return null
  const key = normalizeWorkspaceKey(trimmed)
  if (key.length === 0) return null
  return { key, root: trimmed }
}

function parseRootEntry(entry: string): WorkspaceIdentity | null {
  const trimmed = entry.trim()
  if (trimmed.length === 0) return null

  if (/^file:\/\//i.test(trimmed)) {
    // Parse file: URIs host-independently: fileURLToPath maps Windows drive
    // roots to host-local semantics (e.g. file:///C:/ws on POSIX becomes
    // /C:/ws), which breaks workspace keys on non-Windows hosts.
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'file:') return null
      const decoded = decodeURIComponent(parsed.pathname)
      if (!decoded.startsWith('/')) return null
      const host = parsed.hostname.toLowerCase()
      if (host !== '') {
        // file://server/share is a UNC root and keeps //server/share
        // semantics on every host.
        return toWorkspaceIdentity(path.win32.normalize(`//${host}${decoded}`))
      }
      // POSIX path "/C:/ws" from "file:///C:/ws" is a Windows drive path.
      if (/^\/[a-zA-Z]:\//.test(decoded)) {
        return toWorkspaceIdentity(path.win32.normalize(decoded.slice(1)))
      }
      // file:///server/share is a local UNC path; file:///C:/ has been handled
      // above, so what remains is an absolute POSIX (or local UNC) path.
      return toWorkspaceIdentity(decoded)
    } catch {
      return null
    }
  }

  // Reject any non-file URL scheme (e.g. http://, https://, data:).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return null
  }

  return toWorkspaceIdentity(trimmed)
}

function selectMostSpecificWorkspace(roots: readonly string[]): WorkspaceIdentity | null {
  const unique = new Map<string, { identity: WorkspaceIdentity; order: number }>()
  for (let index = 0; index < roots.length; index += 1) {
    const raw = roots[index]
    if (typeof raw !== 'string') continue
    const identity = parseRootEntry(raw)
    if (identity === null) continue
    if (!unique.has(identity.key)) {
      unique.set(identity.key, { identity, order: index })
    }
  }
  if (unique.size === 0) return null

  const sorted = [...unique.values()].sort((left, right) => {
    const leftSegments = left.identity.key.split('/').filter(Boolean).length
    const rightSegments = right.identity.key.split('/').filter(Boolean).length
    if (rightSegments !== leftSegments) return rightSegments - leftSegments
    if (right.identity.key.length !== left.identity.key.length) {
      return right.identity.key.length - left.identity.key.length
    }
    return left.order - right.order
  })
  return sorted[0]?.identity ?? null
}

async function readExistingNonce(filePath: string): Promise<string | null> {
  for (let attempt = 0; attempt < NONCE_READ_RETRIES; attempt += 1) {
    try {
      const raw = (await readFileWithRetry(filePath)).toString('utf8').trim()
      if (raw.length > 0) return raw
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return null
      throw err
    }
    if (attempt < NONCE_READ_RETRIES - 1) {
      await sleep(NONCE_READ_RETRY_MS)
    }
  }
  return null
}

/**
 * Create (atomically via `wx`) or load the shared runtime nonce persisted in
 * `${dataDir}/.runtime-nonce` so Hook CLI and MCP Server authenticate host context.
 */
export async function createHostContextNonce(dataDir: string): Promise<string> {
  const target = nonceFilePath(dataDir)
  await fs.mkdir(path.dirname(target), { recursive: true })

  const candidate = randomBytes(NONCE_BYTES).toString('hex')
  try {
    const fh = await fs.open(target, 'wx', 0o600)
    try {
      await fh.writeFile(candidate, 'utf8')
      await fh.sync()
    } catch (err) {
      await fh.close().catch(() => {})
      await fs.unlink(target).catch(() => {})
      throw err
    }
    await fh.close()
    return candidate
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) {
      throw err
    }
  }

  const existing = await readExistingNonce(target)
  if (existing !== null) {
    return existing
  }

  // Fallback if an empty file was left behind by an interrupted creator.
  await fs.writeFile(target, candidate, { encoding: 'utf8', mode: 0o600 })
  return candidate
}

/**
 * Verify a candidate runtime nonce against `${dataDir}/.runtime-nonce` using
 * constant-time comparison.
 */
export async function verifyHostContextNonce(dataDir: string, nonce: string): Promise<boolean> {
  if (typeof nonce !== 'string' || nonce.trim().length === 0) {
    return false
  }
  const target = nonceFilePath(dataDir)
  let expected: string
  try {
    expected = (await readFileWithRetry(target)).toString('utf8').trim()
  } catch {
    return false
  }
  if (expected.length === 0) return false

  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(nonce.trim(), 'utf8')
  if (expectedBuf.length !== actualBuf.length) {
    return false
  }
  return timingSafeEqual(expectedBuf, actualBuf)
}

function parseHostContextPayload(raw: unknown): HostContextPayload | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.nonce !== 'string' || raw.nonce.trim().length === 0) return null
  const workspaceRoot =
    typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim().length > 0
      ? raw.workspaceRoot
      : undefined
  const conversationId =
    typeof raw.conversationId === 'string' && raw.conversationId.trim().length > 0
      ? raw.conversationId.trim()
      : undefined
  const approvedScopeOverride = raw.approvedScopeOverride === true

  return {
    nonce: raw.nonce,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(approvedScopeOverride ? { approvedScopeOverride: true } : {}),
  }
}

/**
 * Resolve the authoritative workspace, conversation identity, and scope-override
 * grant for an AGY MCP tool call. Never trusts forged `__agyHostContext` payloads
 * or arbitrary model-supplied `workspaceRoot` arguments.
 */
export async function resolveCallContext(input: {
  args: Record<string, unknown>
  dataDir: string
  sessionStore: AgySessionStateStore
  listRoots?: () => Promise<readonly string[]>
}): Promise<ResolvedCallContext> {
  let workspace: WorkspaceIdentity | null = null
  let conversationId: string | undefined
  let trustedHost = false
  let approvedScopeOverride = false

  // Priority 1: verified PreToolUse-injected __agyHostContext
  const payload = parseHostContextPayload(input.args[HOST_CONTEXT_ARG_KEY])
  if (payload !== null && (await verifyHostContextNonce(input.dataDir, payload.nonce))) {
    trustedHost = true
    approvedScopeOverride = payload.approvedScopeOverride === true
    conversationId = payload.conversationId
    workspace = toWorkspaceIdentity(payload.workspaceRoot)
  }

  // Priority 2: MCP roots/list
  if (workspace === null && input.listRoots !== undefined) {
    try {
      const roots = await input.listRoots()
      workspace = selectMostSpecificWorkspace(roots)
    } catch {
      // Fall through cleanly if the client rejects or times out roots/list.
    }
  }

  // Priority 3: sessionStore anchor (trusted conversationId or unique recent workspace)
  if (workspace === null) {
    if (conversationId !== undefined) {
      const state = await input.sessionStore.read(conversationId)
      workspace = toWorkspaceIdentity(state?.workspaceRoot)
    } else {
      const recent = await input.sessionStore.findRecentSingleWorkspace()
      if (recent !== undefined) {
        workspace = toWorkspaceIdentity(recent.workspaceRoot)
        if (workspace !== null) {
          conversationId = recent.conversationId
        }
      }
    }
  }

  // Priority 4: null (strict global-only degradation)
  return {
    workspace,
    ...(conversationId === undefined ? {} : { conversationId }),
    trustedHost,
    approvedScopeOverride,
  }
}
