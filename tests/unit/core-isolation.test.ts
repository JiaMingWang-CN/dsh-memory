import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGY_EDITABLE_CONFIG_FIELDS,
  resolveMemoryConfig as resolveCoreConfig,
  validateMemoryConfigPatch,
} from '../../src/core/config.ts'
import { resolveMemoryConfig as resolveHostConfig } from '../../src/host/config.ts'
import { MEMORY_TABLE_SCHEMAS } from '../../src/core/storage-contract.ts'
import { foldIndexSources, planIndexRefresh } from '../../src/core/index-protocol.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))

function listFilesByExt(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesByExt(full, extensions))
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full)
  }
  return out
}

describe('core isolation and contract parity', () => {
  it('forbids @deepseek-ai imports inside src/shared and src/core', () => {
    const files = [
      ...listFilesByExt(join(root, 'src/shared'), ['.ts']),
      ...listFilesByExt(join(root, 'src/core'), ['.ts']),
    ]
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/@deepseek-ai\//)
    }
  })

  it('forbids @deepseek-ai imports inside src/desktop', () => {
    const files = listFilesByExt(join(root, 'src/desktop'), ['.ts', '.tsx'])
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/@deepseek-ai\//)
    }
  })

  it('keeps core config defaults 100% aligned with host schemastery config', () => {
    expect(resolveCoreConfig()).toEqual(resolveHostConfig())
    expect(() => validateMemoryConfigPatch({ unknownFlag: true })).toThrow(/unknown|invalid/i)
    expect(AGY_EDITABLE_CONFIG_FIELDS).toContain('redactSecrets')
    expect(AGY_EDITABLE_CONFIG_FIELDS).not.toContain('dreamProvider')
  })

  it('exposes all 6 domain table schemas and pure index protocol folding', () => {
    expect(Object.keys(MEMORY_TABLE_SCHEMAS).sort()).toEqual([
      'audit',
      'dreams',
      'episodes',
      'memories',
      'operations',
      'session_cursors',
    ])
    const folded = foldIndexSources(
      [
        {
          kind: 'memloom',
          form: 'memory-index',
          mode: 'baseline',
          protocolVersion: 1,
          baselineId: 'b1',
          scopeKey: 'c:/ws',
          changes: [{ action: 'add', memoryId: 'm1', contentRevision: 1, digest: 'd1' }],
          invalidations: [],
        },
      ],
      'c:/ws',
      'b1',
    )
    expect(folded?.entries.get('m1')?.contentRevision).toBe(1)
    const plan = planIndexRefresh({
      visible: folded!,
      target: { baselineId: 'b1', scopeKey: 'c:/ws', entries: [] },
      budget: { refreshMaxBytes: 2048, refreshResetBytes: 8192, refreshMinIntervalMs: 60_000 },
      now: new Date('2026-11-24T00:00:00Z'),
    })
    expect(plan.mode).toBe('delta')
    expect(plan.urgent).toBe(true)

    // Legacy 'dsh-memory' baseline + new 'memloom' delta fold seamlessly
    const legacyFolded = foldIndexSources(
      [
        {
          kind: 'dsh-memory',
          form: 'memory-index',
          mode: 'baseline',
          protocolVersion: 1,
          baselineId: 'b1',
          scopeKey: 'c:/ws',
          changes: [{ action: 'add', memoryId: 'm1', contentRevision: 1, digest: 'd1' }],
          invalidations: [],
        },
        {
          kind: 'memloom',
          form: 'memory-index',
          mode: 'delta',
          protocolVersion: 1,
          baselineId: 'b1',
          scopeKey: 'c:/ws',
          changes: [{ action: 'add', memoryId: 'm2', contentRevision: 1, digest: 'd2' }],
          invalidations: [],
        },
      ],
      'c:/ws',
      'b1',
    )
    expect(legacyFolded?.entries.get('m1')?.contentRevision).toBe(1)
    expect(legacyFolded?.entries.get('m2')?.contentRevision).toBe(1)
  })
})
