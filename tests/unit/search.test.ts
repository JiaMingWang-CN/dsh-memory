import { describe, expect, it } from 'vitest'
import { SearchIndex, tokenize } from '../../src/host/search.ts'
import { MemoryId } from '../../src/shared/types.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

const workspaceA = { kind: 'workspace' as const, key: 'ws-a', root: 'C:/ws/a' }

describe('tokenize', () => {
  it('produces CJK unigrams and bigrams', () => {
    const terms = tokenize('构建失败')
    for (const expected of ['构', '建', '失', '败', '构建', '建失', '失败']) {
      expect(terms).toContain(expected)
    }
  })

  it('lower-cases latin runs and drops whitespace and punctuation', () => {
    const terms = tokenize('TypeCheck failed!')
    expect(terms).toContain('typecheck')
    expect(terms).toContain('failed')
    expect(terms).not.toContain('!')
  })
})

describe('SearchIndex.search', () => {
  it('ranks a Chinese title/body match above an unrelated memory', () => {
    const index = new SearchIndex()
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-build'),
        title: '构建前先跑 typecheck',
        body: '构建前先运行 typecheck 以避免构建失败',
        scope: workspaceA,
      }),
    )
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-deploy'),
        title: '部署流程',
        body: '部署到生产环境需要审批',
        scope: workspaceA,
      }),
    )

    const result = index.search({ query: '构建', workspaceKey: 'ws-a' })
    expect(result.results[0]?.id).toBe('mem-build')
    expect(result.results.map((hit) => hit.id)).not.toContain('mem-deploy')
  })

  it('excludes records from a different workspace while keeping global memories', () => {
    const index = new SearchIndex()
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-a'),
        title: 'typecheck',
        body: 'run typecheck',
        scope: workspaceA,
      }),
    )
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-pref'),
        type: 'preference',
        title: 'typecheck preference',
        body: 'always typecheck',
        scope: { kind: 'global' },
      }),
    )

    const result = index.search({ query: 'typecheck', workspaceKey: 'ws-b' })
    expect(result.results.map((hit) => hit.id)).not.toContain('mem-a')
    expect(result.results.map((hit) => hit.id)).toContain('mem-pref')
  })

  it('excludes an expired active record', () => {
    const index = new SearchIndex()
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-expired'),
        title: 'typecheck',
        body: 'run typecheck',
        scope: workspaceA,
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    )
    const now = new Date('2026-11-15T00:00:00.000Z')
    const result = index.search({ query: 'typecheck', workspaceKey: 'ws-a', now })
    expect(result.results).toEqual([])
    expect(result.total).toBe(0)
  })

  it('does not change ordering when only matchCount changes and the index is rebuilt', () => {
    const base = [
      makeMemoryRecord({
        id: MemoryId('mem-1'),
        title: 'build typecheck',
        body: 'build pipeline',
        scope: workspaceA,
      }),
      makeMemoryRecord({
        id: MemoryId('mem-2'),
        title: 'build deploy',
        body: 'build release',
        scope: workspaceA,
      }),
    ]
    const index = new SearchIndex()
    index.rebuild(base)
    const before = index
      .search({ query: 'build', workspaceKey: 'ws-a' })
      .results.map((hit) => hit.id)

    const boosted = base.map((record) =>
      record.id === 'mem-2' ? { ...record, matchCount: 100 } : record,
    )
    index.rebuild(boosted)
    const after = index
      .search({ query: 'build', workspaceKey: 'ws-a' })
      .results.map((hit) => hit.id)
    expect(after).toEqual(before)
  })

  it('does not index malformed global non-preference records', () => {
    const index = new SearchIndex()
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-global-lesson'),
        type: 'lesson',
        title: 'typecheck global lesson',
        body: 'should never cross workspaces',
        scope: { kind: 'global' },
      }),
    )
    const result = index.search({ query: 'typecheck', workspaceKey: 'ws-b' })
    expect(result.results).toEqual([])
  })

  it('honours an explicit workspace-only scope without global records', () => {
    const index = new SearchIndex()
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-local'),
        title: 'typecheck local',
        body: 'run typecheck',
        scope: workspaceA,
      }),
    )
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-global-pref'),
        type: 'preference',
        title: 'typecheck preference',
        body: 'always typecheck',
        scope: { kind: 'global' },
      }),
    )
    const workspaceOnly = index.search({
      query: 'typecheck',
      workspaceKey: 'ws-a',
      scope: 'workspace',
    })
    expect(workspaceOnly.results.map((hit) => hit.id)).toEqual(['mem-local'])

    const globalOnly = index.search({ query: 'typecheck', workspaceKey: 'ws-a', scope: 'global' })
    expect(globalOnly.results.map((hit) => hit.id)).toEqual(['mem-global-pref'])
  })

  it('keeps a query term that sits at the very end of a long body in the snippet', () => {
    const index = new SearchIndex()
    index.add(
      makeMemoryRecord({
        id: MemoryId('mem-tail'),
        title: 'noise',
        body: `${'padding '.repeat(19)}typecheck`,
        scope: workspaceA,
      }),
    )
    const result = index.search({ query: 'typecheck', workspaceKey: 'ws-a' })
    expect(result.results[0]?.snippet).toContain('typecheck')
  })

  it('honours the configured default limit', () => {
    const index = new SearchIndex({ defaultLimit: 1 })
    index.rebuild([
      makeMemoryRecord({
        id: MemoryId('mem-limit-1'),
        title: 'build one',
        body: 'build',
        scope: workspaceA,
      }),
      makeMemoryRecord({
        id: MemoryId('mem-limit-2'),
        title: 'build two',
        body: 'build',
        scope: workspaceA,
      }),
    ])
    const result = index.search({ query: 'build', workspaceKey: 'ws-a' })
    expect(result.results).toHaveLength(1)
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('ranks a durable lesson above an equally matching worklog', () => {
    const index = new SearchIndex()
    const shared = { title: 'typecheck before build', body: 'run typecheck', scope: workspaceA }
    index.add(makeMemoryRecord({ ...shared, id: MemoryId('mem-worklog'), type: 'worklog' }))
    index.add(makeMemoryRecord({ ...shared, id: MemoryId('mem-lesson'), type: 'lesson' }))
    const result = index.search({ query: 'typecheck', workspaceKey: 'ws-a' })
    expect(result.results[0]?.id).toBe('mem-lesson')
  })
})
