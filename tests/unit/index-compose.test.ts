import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  IndexComposer,
  RECENT_TURN_LIMIT,
  renderBaseline,
  type MemoryIndexSourceService,
} from '../../src/host/indexing.ts'
import type { SearchRequest, SearchResult } from '../../src/host/search.ts'
import { MemoryId, type MemoryRecord } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const WS = { key: 'c:/ws/a', root: 'C:/ws/a' }
const OTHER_WS = { key: 'c:/ws/b', root: 'C:/ws/b' }
const NOW = new Date('2026-11-19T12:00:00.000Z')

function fakeContext(): Context {
  return {
    workingDirectory: { ensure: async () => WS.root },
  } as unknown as Context
}

class FakeService implements MemoryIndexSourceService {
  hits: SearchResult = { results: [], total: 0, truncated: false }
  constructor(public records: MemoryRecord[]) {}

  activeInScope(_workspaceKey: string | null): MemoryRecord[] {
    // Intentionally return every record: composeIndex itself must enforce scope.
    return this.records
  }

  search(_request: SearchRequest): SearchResult {
    return this.hits
  }

  read(id: string, _workspaceKey: string | null): MemoryRecord {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) throw new Error('missing')
    return record
  }
}

function humanMessage(text: string): UserMessage {
  return {
    id: 'm',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

function worklog(
  id: string,
  kind: 'turn' | 'daily',
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'worklog',
    worklogKind: kind,
    scope: { kind: 'workspace', ...WS },
    title: `Title ${id}`,
    body: `BODY_SHOULD_NOT_APPEAR_${id}`,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  })
}

function preference(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return makeMemoryRecord({
    id: MemoryId(id),
    type: 'preference',
    scope: { kind: 'global' },
    title: `Preference ${id}`,
    body: 'short body',
    ...overrides,
  })
}

function composerFor(records: MemoryRecord[], indexMaxBytes?: number): IndexComposer {
  return new IndexComposer({
    ctx: fakeContext(),
    service: new FakeService(records),
    ...(indexMaxBytes === undefined ? {} : { indexMaxBytes }),
    now: () => NOW,
  })
}

describe('composeIndex recent work fallback', () => {
  it('falls back to active turn worklogs when no daily exists', async () => {
    const snapshot = await composerFor([
      worklog('turn-1', 'turn', { updatedAt: '2026-11-18T10:00:00.000Z' }),
      worklog('turn-2', 'turn', { updatedAt: '2026-11-18T09:00:00.000Z' }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.filter((entry) => entry.type === 'worklog')).toHaveLength(2)
    expect(snapshot!.entries.map((entry) => entry.memoryId)).toEqual(['turn-1', 'turn-2'])
  })

  it('selects daily worklogs first and fills the rest with turn worklogs', async () => {
    const snapshot = await composerFor([
      worklog('daily-1', 'daily', { updatedAt: '2026-11-10T00:00:00.000Z' }),
      worklog('turn-1', 'turn', { updatedAt: '2026-11-18T10:00:00.000Z' }),
      worklog('turn-2', 'turn', { updatedAt: '2026-11-18T09:00:00.000Z' }),
      worklog('turn-3', 'turn', { updatedAt: '2026-11-18T08:00:00.000Z' }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    const worklogs = snapshot!.entries.filter((entry) => entry.type === 'worklog')
    expect(worklogs).toHaveLength(RECENT_TURN_LIMIT)
    expect(worklogs[0]!.memoryId).toBe('daily-1')
    expect(worklogs.map((entry) => entry.memoryId)).toEqual(['daily-1', 'turn-1', 'turn-2'])
  })

  it('never takes more than three recent turn worklogs', async () => {
    const snapshot = await composerFor([
      worklog('turn-1', 'turn', { updatedAt: '2026-11-18T01:00:00.000Z' }),
      worklog('turn-2', 'turn', { updatedAt: '2026-11-18T02:00:00.000Z' }),
      worklog('turn-3', 'turn', { updatedAt: '2026-11-18T03:00:00.000Z' }),
      worklog('turn-4', 'turn', { updatedAt: '2026-11-18T04:00:00.000Z' }),
      worklog('turn-5', 'turn', { updatedAt: '2026-11-18T05:00:00.000Z' }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.map((entry) => entry.memoryId)).toEqual(['turn-5', 'turn-4', 'turn-3'])
  })

  it('excludes other workspaces, archived and expired records', async () => {
    const snapshot = await composerFor([
      worklog('turn-local', 'turn'),
      worklog('turn-other', 'turn', { scope: { kind: 'workspace', ...OTHER_WS } }),
      worklog('turn-archived', 'turn', { status: 'archived' }),
      worklog('turn-expired', 'turn', { expiresAt: '2026-11-19T00:00:00.000Z' }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.map((entry) => entry.memoryId)).toEqual(['turn-local'])
  })

  it('renders only the turn worklog title and date, never a body summary', async () => {
    const snapshot = await composerFor([
      worklog('turn-secret', 'turn', {
        title: 'Visible worklog title',
        body: 'BODY_MUST_NOT_BE_IN_INDEX',
      }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries[0]!.summary).toBe('')
    const rendered = renderBaseline(snapshot!)
    expect(rendered).toContain('Visible worklog title')
    expect(rendered).toContain('date: 2026-11-18')
    expect(rendered).not.toContain('BODY_MUST_NOT_BE_IN_INDEX')
  })

  it('takes only the three most recent daily worklogs', async () => {
    const snapshot = await composerFor([
      worklog('daily-1', 'daily', { updatedAt: '2026-11-18T01:00:00.000Z' }),
      worklog('daily-2', 'daily', { updatedAt: '2026-11-18T02:00:00.000Z' }),
      worklog('daily-3', 'daily', { updatedAt: '2026-11-18T03:00:00.000Z' }),
      worklog('daily-4', 'daily', { updatedAt: '2026-11-18T04:00:00.000Z' }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.map((entry) => entry.memoryId)).toEqual([
      'daily-4',
      'daily-3',
      'daily-2',
    ])
  })

  it('excludes turn worklogs created more than seven days ago', async () => {
    const snapshot = await composerFor([
      worklog('turn-old', 'turn', {
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-18T10:00:00.000Z',
      }),
      worklog('turn-new', 'turn', { createdAt: '2026-11-18T00:00:00.000Z' }),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.map((entry) => entry.memoryId)).toEqual(['turn-new'])
  })

  it('keeps global preferences and turn worklogs independent', async () => {
    const snapshot = await composerFor([
      preference('pref-global'),
      worklog('turn-local', 'turn'),
    ]).composeIndex({}, [humanMessage('anything')])

    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.map((entry) => entry.memoryId)).toEqual(['pref-global', 'turn-local'])
    expect(snapshot!.entries.find((entry) => entry.memoryId === 'pref-global')?.priority).toBe(100)
    expect(snapshot!.entries.filter((entry) => entry.type === 'worklog')).toHaveLength(1)
  })

  it('keeps turn worklogs at priority 10 so budget cropping drops them first', async () => {
    const records = [
      preference('pref-priority'),
      worklog('turn-priority', 'turn', { title: 'T'.repeat(80) }),
    ]
    const wide = await composerFor(records).composeIndex({}, [humanMessage('anything')])
    const turnEntry = wide!.entries.find((entry) => entry.memoryId === 'turn-priority')
    expect(turnEntry?.priority).toBe(10)

    const tight = await composerFor(records, 400).composeIndex({}, [humanMessage('anything')])
    expect(tight).toBeDefined()
    expect(tight!.entries.map((entry) => entry.memoryId)).toEqual(['pref-priority'])
  })
})
