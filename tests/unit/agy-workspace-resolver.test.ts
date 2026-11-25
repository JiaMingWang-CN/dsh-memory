import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgySessionStateStore } from '../../src/agy/session-state.ts'
import {
  HOST_CONTEXT_ARG_KEY,
  createHostContextNonce,
  resolveCallContext,
  verifyHostContextNonce,
} from '../../src/agy/workspace-resolver.ts'
import { normalizeWorkspaceKey } from '../../src/core/workspace.ts'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-agy-resolver-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('agy workspace resolver and runtime nonce', () => {
  it('persists one shared runtime nonce across concurrent creators and verifies with timing-safe equality', async () => {
    const dataDir = await makeTempDir()

    expect(await verifyHostContextNonce(dataDir, 'missing-file')).toBe(false)

    const [n1, n2, n3] = await Promise.all([
      createHostContextNonce(dataDir),
      createHostContextNonce(dataDir),
      createHostContextNonce(dataDir),
    ])

    expect(n1.length).toBeGreaterThanOrEqual(32)
    expect(n2).toBe(n1)
    expect(n3).toBe(n1)

    const diskNonce = (await fs.readFile(path.join(dataDir, '.runtime-nonce'), 'utf8')).trim()
    expect(diskNonce).toBe(n1)

    expect(await verifyHostContextNonce(dataDir, n1)).toBe(true)
    expect(
      await verifyHostContextNonce(
        dataDir,
        `${n1.slice(0, -1)}0` === n1 ? `${n1.slice(0, -1)}1` : `${n1.slice(0, -1)}0`,
      ),
    ).toBe(false)
    expect(await verifyHostContextNonce(dataDir, 'short')).toBe(false)
    expect(await verifyHostContextNonce(dataDir, '')).toBe(false)
  })

  it('gives verified hook host context top priority over MCP roots and session anchors', async () => {
    const dataDir = await makeTempDir()
    const sessionStore = new AgySessionStateStore(path.join(dataDir, 'sessions'))
    const nonce = await createHostContextNonce(dataDir)

    await sessionStore.write({
      conversationId: 'conv-1',
      workspaceRoot: 'C:\\Workspaces\\FromSession',
      scopeKey: normalizeWorkspaceKey('C:\\Workspaces\\FromSession'),
      indexSources: [],
      captureTurn: 0,
      updatedAt: new Date().toISOString(),
    })

    const ctx = await resolveCallContext({
      args: {
        workspaceRoot: '../forged-relative',
        [HOST_CONTEXT_ARG_KEY]: {
          workspaceRoot: 'C:\\Workspaces\\FromHook\\',
          conversationId: 'conv-1',
          approvedScopeOverride: true,
          nonce,
        },
      },
      dataDir,
      sessionStore,
      listRoots: async () => ['file:///C:/Workspaces/FromRoots'],
    })

    expect(ctx.trustedHost).toBe(true)
    expect(ctx.approvedScopeOverride).toBe(true)
    expect(ctx.conversationId).toBe('conv-1')
    expect(ctx.workspace).toEqual({
      key: 'c:/workspaces/fromhook',
      root: 'C:\\Workspaces\\FromHook\\',
    })
  })

  it('ignores forged __agyHostContext and model-supplied workspaceRoot, degrading to null without roots or anchors', async () => {
    const dataDir = await makeTempDir()
    const sessionStore = new AgySessionStateStore(path.join(dataDir, 'sessions'))
    await createHostContextNonce(dataDir)

    const withBadNonce = await resolveCallContext({
      args: {
        workspaceRoot: '../other',
        [HOST_CONTEXT_ARG_KEY]: {
          workspaceRoot: 'C:\\Workspaces\\SecretRepo',
          conversationId: 'conv-forged',
          approvedScopeOverride: true,
          nonce: 'forged-invalid-nonce',
        },
      },
      dataDir,
      sessionStore,
    })

    expect(withBadNonce).toEqual({
      workspace: null,
      trustedHost: false,
      approvedScopeOverride: false,
    })

    const withMissingNonce = await resolveCallContext({
      args: {
        workspaceRoot: 'C:\\Workspaces\\SecretRepo',
        [HOST_CONTEXT_ARG_KEY]: {
          workspaceRoot: 'C:\\Workspaces\\SecretRepo',
          approvedScopeOverride: true,
        },
      },
      dataDir,
      sessionStore,
    })

    expect(withMissingNonce).toEqual({
      workspace: null,
      trustedHost: false,
      approvedScopeOverride: false,
    })
  })

  it('parses MCP file:// roots on Windows and selects the most specific root', async () => {
    const dataDir = await makeTempDir()
    const sessionStore = new AgySessionStateStore(path.join(dataDir, 'sessions'))

    const ctx = await resolveCallContext({
      args: {},
      dataDir,
      sessionStore,
      listRoots: async () => [
        'http://example.com/not-a-file-uri',
        'file:///C:/Projects/Mono',
        'file:///C:/Projects/Mono/packages/memory',
        'not-valid-relative/path',
      ],
    })

    expect(ctx.trustedHost).toBe(false)
    expect(ctx.approvedScopeOverride).toBe(false)
    expect(ctx.workspace?.key).toBe('c:/projects/mono/packages/memory')
  })

  it('falls back to sessionStore anchor by conversationId or unique recent workspace', async () => {
    const dataDir = await makeTempDir()
    const sessionStore = new AgySessionStateStore(path.join(dataDir, 'sessions'))
    const nonce = await createHostContextNonce(dataDir)
    const nowIso = new Date().toISOString()

    await sessionStore.write({
      conversationId: 'conv-anchor',
      workspaceRoot: 'C:\\Projects\\Anchored',
      scopeKey: normalizeWorkspaceKey('C:\\Projects\\Anchored'),
      indexSources: [],
      captureTurn: 1,
      updatedAt: nowIso,
    })

    // Priority 3a: unique recent workspace when listRoots fails/absent
    const fromSingleRecent = await resolveCallContext({
      args: {},
      dataDir,
      sessionStore,
      listRoots: async () => {
        throw new Error('roots unsupported')
      },
    })
    expect(fromSingleRecent.workspace?.key).toBe('c:/projects/anchored')
    expect(fromSingleRecent.trustedHost).toBe(false)

    // Add a second distinct workspace -> findRecentSingleWorkspace becomes ambiguous -> null
    await sessionStore.write({
      conversationId: 'conv-other',
      workspaceRoot: 'C:\\Projects\\Other',
      scopeKey: normalizeWorkspaceKey('C:\\Projects\\Other'),
      indexSources: [],
      captureTurn: 1,
      updatedAt: nowIso,
    })

    const ambiguous = await resolveCallContext({
      args: {},
      dataDir,
      sessionStore,
    })
    expect(ambiguous.workspace).toBeNull()

    // Priority 3b: trusted conversationId disambiguates session anchor
    const byConversationId = await resolveCallContext({
      args: {
        [HOST_CONTEXT_ARG_KEY]: {
          conversationId: 'conv-other',
          nonce,
        },
      },
      dataDir,
      sessionStore,
    })
    expect(byConversationId.trustedHost).toBe(true)
    expect(byConversationId.conversationId).toBe('conv-other')
    expect(byConversationId.workspace?.key).toBe('c:/projects/other')
  })
})
