import { describe, expect, it } from 'vitest'
import { contentDigest, memoryDomain } from '../../src/host/domain.ts'
import { memoryRecordSchema, type MemoryRecord } from '../../src/shared/types.ts'
import { createFakeHost } from '../helpers/fake-domain.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

describe('memory domain schema', () => {
  it('round-trips a valid memory record through the fake domain', async () => {
    const { ctx } = createFakeHost()
    const domain = await ctx.storageDomain.open(memoryDomain)
    const record = makeMemoryRecord()
    const table = domain.table('memories')
    await table.put(record.id, record)
    expect(table.get(record.id)).toEqual(record)
    await domain.close()
  })

  it('rejects a record missing type or status', async () => {
    const { ctx } = createFakeHost()
    const domain = await ctx.storageDomain.open(memoryDomain)
    const record = makeMemoryRecord()
    const { type: _type, status: _status, ...invalid } = record
    await expect(
      domain.table('memories').put(record.id, invalid as unknown as MemoryRecord),
    ).rejects.toThrow()
  })

  it('rejects a derived memory without any source', () => {
    const record = makeMemoryRecord()
    const invalid = {
      ...record,
      ownership: 'derived' as const,
      sourceRefs: [],
      sourceEpisodeIds: [],
    }
    expect(memoryRecordSchema.safeParse(invalid).success).toBe(false)
  })
})

describe('contentDigest', () => {
  it('ignores statistics but changes with body edits', () => {
    const base = makeMemoryRecord()
    const stats = makeMemoryRecord({ matchCount: 9, useCount: 4 })
    expect(contentDigest(base)).toBe(contentDigest(stats))

    const edited = makeMemoryRecord({ body: 'A different body.' })
    expect(contentDigest(edited)).not.toBe(contentDigest(base))
  })
})
