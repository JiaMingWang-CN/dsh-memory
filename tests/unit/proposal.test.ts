import { describe, expect, it } from 'vitest'
import {
  applyDuplicatePolicy,
  computeProposalKey,
  normalizeTitle,
  type DreamProposalOutput,
} from '../../src/host/proposal.ts'
import { makeMemoryRecord } from '../helpers/factory.ts'

function output(overrides: Partial<DreamProposalOutput> = {}): DreamProposalOutput {
  return {
    type: 'lesson',
    scope: { kind: 'workspace', key: 'ws-a', root: 'C:/ws/a' },
    title: 'Typecheck before build',
    body: 'Run typecheck first.',
    confidence: 0.8,
    importance: 0.5,
    sourceEpisodeIds: ['ep-1'],
    ...overrides,
  }
}

describe('proposalKey stable', () => {
  it('is stable for the same output and changes with body or sources', () => {
    const base = output()
    expect(computeProposalKey(base)).toBe(computeProposalKey(output()))
    expect(computeProposalKey(output({ body: 'different' }))).not.toBe(computeProposalKey(base))
    expect(computeProposalKey(output({ sourceEpisodeIds: ['ep-2'] }))).not.toBe(
      computeProposalKey(base),
    )
  })

  it('normalizes whitespace in titles', () => {
    expect(normalizeTitle('  a   b  ')).toBe('a b')
  })
})

describe('duplicate policy', () => {
  it('skips an exact proposalKey match in any status', () => {
    const key = computeProposalKey(output())
    const existing = makeMemoryRecord({ status: 'active', proposalKey: key })
    expect(applyDuplicatePolicy(existing, output())).toBe('skip')
  })

  it('updates an existing pending record and refuses to overwrite an active one', () => {
    const pending = makeMemoryRecord({
      status: 'pending',
      proposalKey: 'other',
      ownership: 'derived',
      sourceEpisodeIds: ['ep-1'],
    })
    expect(applyDuplicatePolicy(pending, output())).toBe('update-pending')
    const active = makeMemoryRecord({ status: 'active', proposalKey: 'other' })
    expect(applyDuplicatePolicy(active, output())).toBe('skip-active')
  })

  it('never overwrites a pending proposal the user already edited', () => {
    const edited = makeMemoryRecord({
      status: 'pending',
      proposalKey: 'other',
      ownership: 'user',
      reviewedByUserAt: '2026-11-20T00:00:00.000Z',
    })
    expect(applyDuplicatePolicy(edited, output())).toBe('skip-active')
  })
})
