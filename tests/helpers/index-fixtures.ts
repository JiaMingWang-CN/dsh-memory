/** Shared fixtures for index-state and injection integration tests. */
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryIndexSourceService } from '../../src/host/indexing.ts'
import type { IndexEntry, MemoryIndexSnapshot } from '../../src/host/indexing.ts'
import type { SearchRequest, SearchResult } from '../../src/host/search.ts'
import { MemoryId, type MemoryRecord, type MemoryIndexChange } from '../../src/shared/types.ts'
import { makeMemoryRecord } from './factory.ts'

export const WS = { key: 'c:/ws/a', root: 'C:/ws/a' }
export const WS_B = { key: 'c:/ws/b', root: 'C:/ws/b' }

/** A fake context whose working directory resolves to `root`. */
export function fakeContext(root: string = WS.root): Context {
  return { workingDirectory: { ensure: async () => root } } as unknown as Context
}

/** In-memory memory read surface used by the injector and composer. */
export class FakeIndexService implements MemoryIndexSourceService {
  hits: SearchResult = { results: [], total: 0, truncated: false }
  constructor(public records: MemoryRecord[] = []) {}

  activeInScope(workspaceKey: string | null): MemoryRecord[] {
    return this.records.filter((record) => {
      if (record.status !== 'active') return false
      if (record.scope.kind === 'global') return record.type === 'preference'
      return workspaceKey !== null && record.scope.key === workspaceKey
    })
  }

  search(_request: SearchRequest): SearchResult {
    return this.hits
  }

  read(id: string, _workspaceKey: string | null): MemoryRecord {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) throw new Error(`missing memory ${id}`)
    return record
  }
}

/** Build a valid preference record in the global scope. */
export function preference(id: string, body = 'pref body', importance = 0.5): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'preference',
    scope: { kind: 'global' },
    body,
    importance,
  })
}

/** Build a valid workspace lesson record. */
export function lesson(id: string, workspace = WS, body = 'lesson body'): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'lesson',
    scope: { kind: 'workspace', key: workspace.key, root: workspace.root },
    body,
    importance: 0.9,
  })
}

/** A plain direct human message. */
export function humanMessage(text = 'hello'): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** Wrap a memory-index source in a durable-looking user message. */
export function indexMessage(source: unknown): UserMessage {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text: 'index' }],
    source,
  } as unknown as UserMessage
}

/** Build a baseline (or reset) memory-index source. */
export function baselineSource(
  baselineId: string,
  scopeKey: string,
  changes: MemoryIndexChange[],
  options: {
    mode?: 'baseline' | 'reset'
    invalidations?: { memoryId: string; contentRevision: number }[]
    protocolVersion?: number
  } = {},
): unknown {
  return {
    kind: 'memloom',
    form: 'memory-index',
    mode: options.mode ?? 'baseline',
    protocolVersion: options.protocolVersion ?? 1,
    baselineId,
    scopeKey,
    changes,
    invalidations: options.invalidations ?? [],
  }
}

/** Build a delta memory-index source. */
export function deltaSource(
  baselineId: string,
  scopeKey: string,
  changes: MemoryIndexChange[],
): unknown {
  return { ...(baselineSource(baselineId, scopeKey, changes) as object), mode: 'delta' }
}

/** One expected index entry. */
export function indexEntry(
  memoryId: string,
  contentRevision = 1,
  digest = `digest-${memoryId}`,
): IndexEntry {
  return {
    memoryId,
    type: 'lesson',
    title: memoryId,
    summary: 'summary',
    contentRevision,
    digest,
    priority: 50,
  }
}

/** Build an expected snapshot. */
export function snapshotOf(
  scopeKey: string,
  entries: IndexEntry[],
  baselineId = `baseline-${scopeKey}`,
): MemoryIndexSnapshot {
  return { baselineId, scopeKey, entries }
}
