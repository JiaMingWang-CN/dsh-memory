import { describe, expect, it } from 'vitest'
import { isKnownWorkspace, resolveInitialWorkspace } from '../../src/client/WorkspaceFilter.tsx'
import type { WorkspaceInfo } from '../../src/client/context.ts'

const workspaces: WorkspaceInfo[] = [
  { id: 'ws-old', title: 'Old', path: 'C:/old', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'ws-new', title: 'New', path: 'C:/new', updatedAt: '2026-03-01T00:00:00.000Z' },
]

describe('initial workspace', () => {
  it('prefers the workspace the user explicitly picked', () => {
    expect(resolveInitialWorkspace('c:/old', 'c:/new', workspaces)).toBe('c:/old')
  })

  it('uses the current project when nothing was picked', () => {
    expect(resolveInitialWorkspace(undefined, 'c:/old', workspaces)).toBe('c:/old')
  })

  it('ignores a stale stored or current key', () => {
    expect(resolveInitialWorkspace('c:/gone', 'c:/gone', workspaces)).toBe('c:/new')
  })

  it('keeps an explicit all choice', () => {
    expect(resolveInitialWorkspace('all', 'c:/old', workspaces)).toBe('all')
  })

  it('falls back to all without any workspace row', () => {
    expect(resolveInitialWorkspace(undefined, null, [])).toBe('all')
  })

  it('preserves a non-empty current workspace when workspaces have not loaded yet (L8)', () => {
    expect(resolveInitialWorkspace(undefined, 'c:/pending', [])).toBe('c:/pending')
  })

  it('recognises only listed keys and the all sentinel', () => {
    expect(isKnownWorkspace('c:/old', workspaces)).toBe(true)
    expect(isKnownWorkspace('all', workspaces)).toBe(true)
    expect(isKnownWorkspace('c:/gone', workspaces)).toBe(false)
  })
})
