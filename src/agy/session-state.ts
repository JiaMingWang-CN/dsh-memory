/**
 * Per-conversation session state store under `${PLUGIN_DATA}/sessions/`.
 *
 * Persists lightweight index folding state, capture turn/assistant summary,
 * and workspace anchor metadata across short-lived AGY Hook processes.
 * @module memloom/agy/session-state
 */
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeWorkspaceKey } from '../core/workspace.ts'
import type { MemoryIndexSource } from '../shared/types.ts'
import { readFileWithRetry, writeFileAtomic } from './storage.ts'

const DEFAULT_RECENT_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_EXPIRE_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Persisted AGY session anchor, index folding, and turn capture state. */
export interface AgySessionState {
  conversationId: string
  workspaceRoot?: string
  scopeKey?: string
  indexSources: MemoryIndexSource[]
  captureTurn: number
  previousAssistantText?: string
  pendingAutoDreamCheck?: boolean
  lastAutoDreamPromptAt?: string
  updatedAt: string
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code
}

function sanitizeConversationId(conversationId: string): string {
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) {
    return conversationId
  }
  const encoded = encodeURIComponent(conversationId).replace(/\./g, '%2E')
  if (encoded.length > 0 && encoded.length <= 128) {
    return encoded
  }
  return Buffer.from(conversationId, 'utf8').toString('base64url').slice(0, 128)
}

function parseSessionState(raw: unknown): AgySessionState | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.conversationId !== 'string' ||
    obj.conversationId.length === 0 ||
    !Array.isArray(obj.indexSources) ||
    typeof obj.captureTurn !== 'number' ||
    !Number.isInteger(obj.captureTurn) ||
    obj.captureTurn < 0 ||
    typeof obj.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(obj.updatedAt))
  ) {
    return undefined
  }

  return {
    conversationId: obj.conversationId,
    indexSources: obj.indexSources as MemoryIndexSource[],
    captureTurn: obj.captureTurn,
    updatedAt: obj.updatedAt,
    ...(typeof obj.workspaceRoot === 'string' ? { workspaceRoot: obj.workspaceRoot } : {}),
    ...(typeof obj.scopeKey === 'string' ? { scopeKey: obj.scopeKey } : {}),
    ...(typeof obj.previousAssistantText === 'string'
      ? { previousAssistantText: obj.previousAssistantText }
      : {}),
    ...(typeof obj.pendingAutoDreamCheck === 'boolean'
      ? { pendingAutoDreamCheck: obj.pendingAutoDreamCheck }
      : {}),
    ...(typeof obj.lastAutoDreamPromptAt === 'string' &&
    !Number.isNaN(Date.parse(obj.lastAutoDreamPromptAt))
      ? { lastAutoDreamPromptAt: obj.lastAutoDreamPromptAt }
      : {}),
  }
}

/** Manages `${PLUGIN_DATA}/sessions/<conversationId>.json` cache files. */
export class AgySessionStateStore {
  private readonly sessionsDir: string

  constructor(sessionsDir: string) {
    this.sessionsDir = path.resolve(sessionsDir)
  }

  private filePathFor(conversationId: string): string {
    return path.join(this.sessionsDir, `${sanitizeConversationId(conversationId)}.json`)
  }

  /**
   * Read the cached state for one conversation, or `undefined` if absent/invalid.
   */
  async read(conversationId: string): Promise<AgySessionState | undefined> {
    if (conversationId.trim().length === 0) return undefined
    let raw: Buffer
    try {
      raw = await readFileWithRetry(this.filePathFor(conversationId))
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return undefined
      throw err
    }

    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      return parseSessionState(parsed)
    } catch {
      return undefined
    }
  }

  /**
   * Persist session state atomically.
   */
  async write(state: AgySessionState): Promise<void> {
    const clean: AgySessionState = {
      conversationId: state.conversationId,
      indexSources: state.indexSources,
      captureTurn: state.captureTurn,
      updatedAt: state.updatedAt,
      ...(state.workspaceRoot !== undefined ? { workspaceRoot: state.workspaceRoot } : {}),
      ...(state.scopeKey !== undefined ? { scopeKey: state.scopeKey } : {}),
      ...(state.previousAssistantText !== undefined
        ? { previousAssistantText: state.previousAssistantText }
        : {}),
      ...(state.pendingAutoDreamCheck !== undefined
        ? { pendingAutoDreamCheck: state.pendingAutoDreamCheck }
        : {}),
      ...(state.lastAutoDreamPromptAt !== undefined
        ? { lastAutoDreamPromptAt: state.lastAutoDreamPromptAt }
        : {}),
    }
    await writeFileAtomic(
      this.filePathFor(state.conversationId),
      Buffer.from(JSON.stringify(clean, null, 2), 'utf8'),
    )
  }

  /**
   * Return the active workspace anchor ONLY when strictly 1 unique recent
   * non-empty `workspaceRoot` exists within `maxAgeMs`.
   */
  async findRecentSingleWorkspace(
    maxAgeMs = DEFAULT_RECENT_WORKSPACE_MAX_AGE_MS,
    now: Date = new Date(),
  ): Promise<{ conversationId: string; workspaceRoot: string } | undefined> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.sessionsDir)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return undefined
      throw err
    }

    const nowMs = now.getTime()
    const byKey = new Map<
      string,
      { conversationId: string; workspaceRoot: string; updatedAtMs: number }
    >()

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      let state: AgySessionState | undefined
      try {
        const raw = await readFileWithRetry(path.join(this.sessionsDir, entry))
        state = parseSessionState(JSON.parse(raw.toString('utf8')))
      } catch {
        continue
      }
      if (state === undefined || state.workspaceRoot === undefined) continue
      const trimmedRoot = state.workspaceRoot.trim()
      if (trimmedRoot.length === 0) continue

      const updatedAtMs = Date.parse(state.updatedAt)
      if (Number.isNaN(updatedAtMs) || nowMs - updatedAtMs > maxAgeMs) continue

      const key = normalizeWorkspaceKey(trimmedRoot)
      const prev = byKey.get(key)
      if (prev === undefined || updatedAtMs > prev.updatedAtMs) {
        byKey.set(key, {
          conversationId: state.conversationId,
          workspaceRoot: trimmedRoot,
          updatedAtMs,
        })
      }
    }

    if (byKey.size !== 1) return undefined
    const only = [...byKey.values()][0]!
    return {
      conversationId: only.conversationId,
      workspaceRoot: only.workspaceRoot,
    }
  }

  /**
   * Delete session cache files older than `maxAgeDays`.
   * @returns Number of expired session files deleted.
   */
  async pruneExpired(maxAgeDays = DEFAULT_EXPIRE_DAYS, now: Date = new Date()): Promise<number> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.sessionsDir)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return 0
      throw err
    }

    const maxAgeMs = maxAgeDays * MS_PER_DAY
    const nowMs = now.getTime()
    let pruned = 0

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const fullPath = path.join(this.sessionsDir, entry)
      let timestampMs: number | undefined

      try {
        const raw = await readFileWithRetry(fullPath)
        const state = parseSessionState(JSON.parse(raw.toString('utf8')))
        if (state !== undefined) {
          timestampMs = Date.parse(state.updatedAt)
        }
      } catch {
        // Fall back to file mtime below.
      }

      if (timestampMs === undefined || Number.isNaN(timestampMs)) {
        const stat = await fs.stat(fullPath).catch(() => null)
        if (stat === null) continue
        timestampMs = stat.mtimeMs
      }

      if (nowMs - timestampMs > maxAgeMs) {
        try {
          await fs.unlink(fullPath)
          pruned += 1
        } catch {
          // Ignore concurrent deletion.
        }
      }
    }

    return pruned
  }
}
