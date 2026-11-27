import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgyConfigStore } from '../../src/agy/config-store.ts'
import { AgySessionStateStore } from '../../src/agy/session-state.ts'
import { FileMemoryDomain } from '../../src/agy/storage.ts'
import {
  REGULAR_TOOL_NAMES,
  SENSITIVE_TOOL_NAMES,
  createAgyTools,
  type AgyToolDefinition,
} from '../../src/agy/tools.ts'
import { HOST_CONTEXT_ARG_KEY, type ResolvedCallContext } from '../../src/agy/workspace-resolver.ts'
import { MemoryEngine } from '../../src/core/engine.ts'
import { OperationError } from '../../src/core/operations.ts'
import { normalizeWorkspaceKey } from '../../src/core/workspace.ts'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-memory-agy-tools-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function makeWorkspaceCtx(
  root: string,
  options?: { conversationId?: string; trustedHost?: boolean; approvedScopeOverride?: boolean },
): ResolvedCallContext {
  return {
    workspace: { key: normalizeWorkspaceKey(root), root },
    ...(options?.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    trustedHost: options?.trustedHost ?? true,
    approvedScopeOverride: options?.approvedScopeOverride ?? false,
  }
}

function makeNoWorkspaceCtx(approvedScopeOverride = false): ResolvedCallContext {
  return {
    workspace: null,
    trustedHost: false,
    approvedScopeOverride,
  }
}

async function setupHarness() {
  const dataDir = await makeTempDir()
  const storePath = path.join(dataDir, 'memory.json')
  const configPath = path.join(dataDir, 'config.json')
  const sessionsDir = path.join(dataDir, 'sessions')

  let engineRef: MemoryEngine | null = null
  const domain = await FileMemoryDomain.open({
    storePath,
    onReload: () => engineRef?.syncSearchIndex(),
  })
  const configStore = new AgyConfigStore(configPath)
  const sessionStore = new AgySessionStateStore(sessionsDir)
  const initialConfig = await configStore.load()
  const engine = new MemoryEngine({ domain, config: initialConfig })
  engineRef = engine
  await domain.withWriteLock(() => engine.recover())

  const tools = createAgyTools({ domain, engine, configStore, sessionStore, dataDir })
  const byName = new Map<string, AgyToolDefinition>(tools.map((tool) => [tool.name, tool]))
  const getTool = (name: string): AgyToolDefinition => {
    const found = byName.get(name)
    if (found === undefined) throw new Error(`missing tool: ${name}`)
    return found
  }

  return {
    dataDir,
    storePath,
    configPath,
    domain,
    configStore,
    sessionStore,
    engine,
    tools,
    getTool,
  }
}

async function expectOperationError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    expect.unreachable(`expected OperationError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError)
    expect((error as OperationError).code).toBe(code)
  }
}

describe('agy tiered MCP memory tools', () => {
  it('registers exactly 12 regular and 8 sensitive tools with valid JSON Schema objects', async () => {
    const { tools, getTool } = await setupHarness()

    expect(REGULAR_TOOL_NAMES).toHaveLength(12)
    expect(SENSITIVE_TOOL_NAMES).toHaveLength(8)
    expect(tools).toHaveLength(20)

    const regularActual = tools.filter((tool) => !tool.sensitive).map((tool) => tool.name)
    const sensitiveActual = tools.filter((tool) => tool.sensitive).map((tool) => tool.name)
    expect(regularActual).toEqual([...REGULAR_TOOL_NAMES])
    expect(sensitiveActual).toEqual([...SENSITIVE_TOOL_NAMES])

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.inputSchema.properties).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }

    const writeTool = getTool('memory_write')
    expect(writeTool.description).toMatch(/AGENTS\.md/)
    expect(writeTool.description).toMatch(/Strong secrets/i)
  })

  it('strips __agyHostContext before strict zod parsing', async () => {
    const { getTool } = await setupHarness()
    const status = (await getTool('memory_status').execute(
      {
        [HOST_CONTEXT_ARG_KEY]: {
          workspaceRoot: 'C:\\Workspaces\\Demo',
          nonce: 'any',
        },
      },
      makeWorkspaceCtx('C:\\Workspaces\\Demo'),
    )) as { ready: boolean }
    expect(status.ready).toBe(true)
  })

  it('enforces strict global-only degradation when workspace is null (Review Focus #3)', async () => {
    const { getTool, engine, domain } = await setupHarness()
    const wsCtx = makeWorkspaceCtx('C:\\Workspaces\\Alpha')
    const nullCtx = makeNoWorkspaceCtx()

    // Global preference write succeeds without workspace
    const globalPref = (await getTool('memory_write').execute(
      {
        type: 'preference',
        scope: 'global',
        title: 'Use pnpm',
        body: 'Always prefer pnpm over npm.',
      },
      nullCtx,
    )) as { id: string; status: string }
    expect(globalPref.status).toBe('active')

    // Workspace write or non-preference write without workspace throws MEMORY_FORBIDDEN_SCOPE
    await expectOperationError(
      getTool('memory_write').execute(
        {
          type: 'lesson',
          scope: 'workspace',
          title: 'Workspace note',
          body: 'Should be rejected when no workspace.',
        },
        nullCtx,
      ),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_write').execute(
        {
          type: 'lesson',
          title: 'Implicit scope lesson',
          body: 'Only preferences may be global.',
        },
        nullCtx,
      ),
      'MEMORY_FORBIDDEN_SCOPE',
    )

    // Create a workspace active record, an archived record, and a pending dream proposal
    const wsActive = (await getTool('memory_write').execute(
      {
        type: 'lesson',
        title: 'Alpha build quirk',
        body: 'Run pnpm build before packing.',
      },
      wsCtx,
    )) as { id: string; contentRevision: number }

    const wsArchived = (await getTool('memory_write').execute(
      {
        type: 'wiki',
        title: 'Alpha archive target',
        body: 'Old note to archive.',
      },
      wsCtx,
    )) as { id: string; contentRevision: number }
    await getTool('memory_forget').execute({ id: wsArchived.id }, wsCtx)

    const ep = await domain.withWriteLock(() =>
      engine.appendEpisode({
        sessionId: 'sess-alpha',
        workspaceKey: normalizeWorkspaceKey('C:\\Workspaces\\Alpha'),
        workspaceRoot: 'C:\\Workspaces\\Alpha',
        turn: 1,
        kind: 'explicit',
        prompt: 'Remember alpha rule',
        sourceSeqs: [1],
      }),
    )
    const prepared = (await getTool('memory_dream_prepare').execute({}, wsCtx)) as {
      dreamId: string
    }
    const committed = (await getTool('memory_dream_commit').execute(
      {
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Alpha pending proposal',
            body: 'Pending proposal in alpha workspace.',
            confidence: 0.9,
            importance: 0.8,
            sourceEpisodeIds: [ep!.id],
          },
        ],
      },
      wsCtx,
    )) as { createdIds: string[] }
    const wsPendingId = committed.createdIds[0]!

    // With workspace === null, reading/forgetting/reviewing/restoring/deleting workspace IDs all throw MEMORY_FORBIDDEN_SCOPE
    await expectOperationError(
      getTool('memory_read').execute({ id: wsActive.id }, nullCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_forget').execute({ id: wsActive.id }, nullCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_review').execute({ id: wsPendingId, action: 'accept' }, nullCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_restore').execute({ id: wsArchived.id }, nullCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_delete').execute(
        { id: wsActive.id, expectedContentRevision: wsActive.contentRevision },
        nullCtx,
      ),
      'MEMORY_FORBIDDEN_SCOPE',
    )
  })

  it('enforces cross-workspace list/export gates, pure read-only export, and no-overwrite outputPath (Review Focus #4)', async () => {
    const { dataDir, getTool } = await setupHarness()
    const alphaCtx = makeWorkspaceCtx('C:\\Workspaces\\Alpha')
    const betaCtx = makeWorkspaceCtx('C:\\Workspaces\\Beta')
    const alphaApprovedCtx = makeWorkspaceCtx('C:\\Workspaces\\Alpha', {
      approvedScopeOverride: true,
    })

    // Configure archivePurgePolicy='after-export'
    await getTool('memory_config').execute({ archivePurgePolicy: 'after-export' }, alphaCtx)

    const alphaNote = (await getTool('memory_write').execute(
      { type: 'lesson', title: 'Alpha note', body: 'Alpha body' },
      alphaCtx,
    )) as { id: string }
    await getTool('memory_forget').execute({ id: alphaNote.id }, alphaCtx)

    await getTool('memory_write').execute(
      { type: 'lesson', title: 'Beta note', body: 'Beta body' },
      betaCtx,
    )

    // memory_list rejects scope='all' and cross-workspace workspaceRoot without override
    await expectOperationError(
      getTool('memory_list').execute({ scope: 'all' }, alphaCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_list').execute({ workspaceRoot: 'C:\\Workspaces\\Beta' }, alphaCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )

    // With approvedScopeOverride, both succeed
    const allListed = (await getTool('memory_list').execute(
      { scope: 'all' },
      alphaApprovedCtx,
    )) as { total: number }
    expect(allListed.total).toBe(2)

    const betaListed = (await getTool('memory_list').execute(
      { workspaceRoot: 'C:\\Workspaces\\Beta' },
      alphaApprovedCtx,
    )) as { items: { title: string }[] }
    expect(betaListed.items.map((item) => item.title)).toEqual(['Beta note'])

    // memory_export is strictly read-only even with archivePurgePolicy='after-export'
    const exported = (await getTool('memory_export').execute(
      { includeArchived: true },
      alphaCtx,
    )) as { format: string; memories: { id: string }[] }
    expect(exported.format).toBe('memloom')
    expect(exported.memories.some((m) => m.id === alphaNote.id)).toBe(true)

    const statusAfterExport = (await getTool('memory_status').execute({}, alphaCtx)) as {
      counts: { archived: number }
    }
    expect(statusAfterExport.counts.archived).toBe(1)

    // memory_export rejects scope='all', cross-workspace, and outputPath without override
    const outPath = path.join(dataDir, 'export-out.json')
    await expectOperationError(
      getTool('memory_export').execute({ scope: 'all' }, alphaCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_export').execute({ workspaceRoot: 'C:\\Workspaces\\Beta' }, alphaCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )
    await expectOperationError(
      getTool('memory_export').execute({ outputPath: outPath }, alphaCtx),
      'MEMORY_FORBIDDEN_SCOPE',
    )

    // Approved outputPath writes cleanly once, then refuses to overwrite existing file
    const written = (await getTool('memory_export').execute(
      { scope: 'all', outputPath: outPath },
      alphaApprovedCtx,
    )) as { outputPath: string; memoryCount: number }
    expect(written.outputPath).toBe(path.resolve(outPath))
    expect(written.memoryCount).toBe(2)
    const diskExport = JSON.parse(await fs.readFile(outPath, 'utf8')) as {
      memories: unknown[]
    }
    expect(diskExport.memories).toHaveLength(2)

    // Overwrite attempt must fail and preserve existing file
    await fs.writeFile(outPath, '{"sentinel":true}', 'utf8')
    await expectOperationError(
      getTool('memory_export').execute({ scope: 'all', outputPath: outPath }, alphaApprovedCtx),
      'MEMORY_CONFLICT',
    )
    expect(await fs.readFile(outPath, 'utf8')).toBe('{"sentinel":true}')
  })

  it('hot-applies editable AGY config fields and rejects DSH-only, non-editable, and unknown fields', async () => {
    const { configPath, getTool } = await setupHarness()
    const ctx = makeWorkspaceCtx('C:\\Workspaces\\ConfigTest')

    const updated = (await getTool('memory_config').execute(
      {
        indexMaxBytes: 2048,
        redactSecrets: true,
        searchLimit: 10,
        dreamSubagentModel: 'flash_lite',
      },
      ctx,
    )) as {
      config: {
        indexMaxBytes: number
        redactSecrets: boolean
        searchLimit: number
        dreamSubagentModel: string
      }
    }

    expect(updated.config.indexMaxBytes).toBe(2048)
    expect(updated.config.redactSecrets).toBe(true)
    expect(updated.config.searchLimit).toBe(10)
    expect(updated.config.dreamSubagentModel).toBe('flash_lite')

    const status = (await getTool('memory_status').execute({}, ctx)) as {
      config: { indexMaxBytes: number; searchLimit: number; dreamSubagentModel: string }
    }
    expect(status.config.indexMaxBytes).toBe(2048)
    expect(status.config.searchLimit).toBe(10)
    expect(status.config.dreamSubagentModel).toBe('flash_lite')

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(persisted.indexMaxBytes).toBe(2048)
    expect(persisted.searchLimit).toBe(10)
    expect(persisted.dreamSubagentModel).toBe('flash_lite')

    // memory_dream_prepare returns recommendedSubagentModel and records model on DreamRun
    const prep = (await getTool('memory_dream_prepare').execute({}, ctx)) as {
      dreamId: string
      recommendedSubagentModel: string
    }
    expect(prep.recommendedSubagentModel).toBe('flash_lite')

    // Reject DSH-only fields
    for (const field of [
      { dreamModelMode: 'fixed' },
      { dreamProvider: 'openai' },
      { dreamModel: 'gpt-5' },
      { dreamReasoningEffort: 'high' },
      { maxActiveMemories: 100 },
      { unknownField: true },
    ]) {
      await expectOperationError(
        getTool('memory_config').execute(field, ctx),
        'MEMORY_INVALID_CONFIG',
      )
    }
  })

  it('supports full lifecycle: write -> search -> read -> forget -> restore -> delete and dream -> review -> undo', async () => {
    const { getTool, engine, domain, storePath } = await setupHarness()
    const ctx = makeWorkspaceCtx('C:\\Workspaces\\Lifecycle', { conversationId: 'conv-life' })

    // 1. Write -> Search (matchCount only) -> Read (useCount only) -> Forget -> Restore -> Delete
    const created = (await getTool('memory_write').execute(
      {
        type: 'lesson',
        title: 'Vitest ESM imports',
        body: 'Always include explicit .ts extensions in relative imports.',
        tags: ['vitest', 'esm'],
        importance: 0.85,
      },
      ctx,
    )) as { id: string; contentRevision: number; status: string }
    expect(created.status).toBe('active')
    expect(created.contentRevision).toBe(1)

    const updatedWrite = (await getTool('memory_write').execute(
      {
        id: created.id,
        expectedContentRevision: created.contentRevision,
        type: 'lesson',
        title: 'Vitest ESM imports',
        body: 'Always include explicit .ts extensions in relative ESM imports.',
        tags: ['vitest', 'esm'],
        importance: 0.9,
      },
      ctx,
    )) as { id: string; contentRevision: number; status: string }
    expect(updatedWrite.contentRevision).toBe(2)

    const searched = (await getTool('memory_search').execute(
      { query: 'Vitest extensions', type: 'lesson', tags: ['vitest'] },
      ctx,
    )) as { results: { id: string }[] }
    expect(searched.results.map((r) => r.id)).toEqual([created.id])

    const afterSearch = domain.table('memories').get(created.id as never)
    expect(afterSearch?.matchCount).toBe(1)
    expect(afterSearch?.useCount).toBe(0)

    const read = (await getTool('memory_read').execute({ id: created.id }, ctx)) as {
      id: string
      body: string
      matchCount: number
      useCount: number
      contentRevision: number
    }
    expect(read.body).toContain('.ts extensions')
    expect(read.matchCount).toBe(1)
    expect(read.useCount).toBe(1)

    // Forged permanent flag on memory_forget must be rejected
    await expectOperationError(
      getTool('memory_forget').execute({ id: created.id, permanent: true }, ctx),
      'MEMORY_FORBIDDEN',
    )

    const forgotten = (await getTool('memory_forget').execute(
      { id: created.id, reason: 'superseded' },
      ctx,
    )) as { status: string; contentRevision: number }
    expect(forgotten.status).toBe('archived')

    const restored = (await getTool('memory_restore').execute({ id: created.id }, ctx)) as {
      status: string
      ownership: string
      contentRevision: number
    }
    expect(restored.status).toBe('active')
    expect(restored.ownership).toBe('user')

    const audit = (await getTool('memory_audit').execute({ memoryId: created.id }, ctx)) as {
      items: unknown[]
    }
    expect(audit.items.length).toBeGreaterThanOrEqual(3)

    const deleted = (await getTool('memory_delete').execute(
      { id: created.id, expectedContentRevision: restored.contentRevision },
      ctx,
    )) as { deleted: boolean }
    expect(deleted.deleted).toBe(true)
    expect(domain.table('memories').get(created.id as never)).toBeUndefined()

    // 2. Two-stage dream -> review(accept) -> undo_dream
    const ep = await domain.withWriteLock(() =>
      engine.appendEpisode({
        sessionId: 'sess-life',
        workspaceKey: normalizeWorkspaceKey('C:\\Workspaces\\Lifecycle'),
        workspaceRoot: 'C:\\Workspaces\\Lifecycle',
        turn: 1,
        kind: 'user-correction',
        prompt: 'Use strict mode',
        correctionText: 'Do not disable exactOptionalPropertyTypes.',
        sourceSeqs: [1],
      }),
    )

    const prepared = (await getTool('memory_dream_prepare').execute({}, ctx)) as {
      dreamId: string
      episodeIds: string[]
      systemPrompt: string
    }
    expect(prepared.episodeIds).toEqual([ep!.id])
    expect(prepared.systemPrompt.length).toBeGreaterThan(20)

    const committed = (await getTool('memory_dream_commit').execute(
      {
        dreamId: prepared.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Keep exactOptionalPropertyTypes enabled',
            body: 'Conditionally spread optional properties instead of passing undefined.',
            confidence: 0.9,
            importance: 0.9,
            sourceEpisodeIds: [ep!.id],
          },
        ],
      },
      ctx,
    )) as { status: string; createdIds: string[]; processedEpisodes: number }
    expect(committed.status).toBe('completed')
    expect(committed.createdIds).toHaveLength(1)
    expect(committed.processedEpisodes).toBe(1)

    const proposalId = committed.createdIds[0]!
    const accepted = (await getTool('memory_review').execute(
      { id: proposalId, action: 'accept' },
      ctx,
    )) as { status: string; ownership: string; reviewedByUserAt?: string }
    expect(accepted.status).toBe('active')
    expect(accepted.ownership).toBe('user')
    expect(accepted.reviewedByUserAt).toBeDefined()

    // Undo dream on a freshly dreamed unreviewed proposal
    const ep2 = await domain.withWriteLock(() =>
      engine.appendEpisode({
        sessionId: 'sess-life-2',
        workspaceKey: normalizeWorkspaceKey('C:\\Workspaces\\Lifecycle'),
        workspaceRoot: 'C:\\Workspaces\\Lifecycle',
        turn: 1,
        kind: 'explicit',
        prompt: 'Temp rule to undo',
        sourceSeqs: [2],
      }),
    )
    const prep2 = (await getTool('memory_dream_prepare').execute({}, ctx)) as { dreamId: string }
    const comm2 = (await getTool('memory_dream_commit').execute(
      {
        dreamId: prep2.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Undoable dream memory',
            body: 'Will be undone by memory_undo_dream.',
            confidence: 0.8,
            importance: 0.7,
            sourceEpisodeIds: [ep2!.id],
          },
        ],
      },
      ctx,
    )) as { createdIds: string[] }
    const undone = (await getTool('memory_undo_dream').execute(
      { dreamId: prep2.dreamId },
      ctx,
    )) as { undone: number }
    expect(undone.undone).toBe(1)
    expect(domain.table('memories').get(comm2.createdIds[0]! as never)).toBeUndefined()

    // 3. Organize prepare + commit
    const orgPrep = (await getTool('memory_organize_prepare').execute({}, ctx)) as {
      dreamId: string
      recordIds: string[]
    }
    expect(orgPrep.recordIds).toContain(proposalId)
    const orgComm = (await getTool('memory_organize_commit').execute(
      {
        dreamId: orgPrep.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'Consolidated TypeScript strictness',
            body: 'Keep exactOptionalPropertyTypes enabled and conditionally spread optional fields.',
            confidence: 0.9,
            importance: 0.9,
            supersedes: [proposalId],
          },
        ],
      },
      ctx,
    )) as { createdIds: string[] }
    expect(orgComm.createdIds).toHaveLength(1)

    // 4. Rebuild deletes derived pending proposal but retains user-owned active memory
    const rebuildReport = (await getTool('memory_rebuild').execute({ confirm: true }, ctx)) as {
      deleted: number
      retainedUser: number
    }
    expect(rebuildReport.deleted).toBe(1)
    expect(rebuildReport.retainedUser).toBeGreaterThanOrEqual(1)

    // 5. Export -> Purge -> Import round-trip
    const snapshot = (await getTool('memory_export').execute(
      { scope: 'workspace', includeArchived: true },
      ctx,
    )) as { memories: unknown[] }
    expect(snapshot.memories).toHaveLength(1)

    const scopeKey = normalizeWorkspaceKey('C:\\Workspaces\\Lifecycle')
    const purgeReport = (await getTool('memory_purge').execute(
      { scope: 'workspace', confirmText: `PURGE ${scopeKey}` },
      ctx,
    )) as { deleted: number }
    expect(purgeReport.deleted).toBe(1)

    const importReport = (await getTool('memory_import').execute(
      { payload: snapshot, mode: 'merge' },
      ctx,
    )) as { created: number }
    expect(importReport.created).toBe(1)

    // 6. External disk write is synced before read tools execute
    const peerDomain = await FileMemoryDomain.open({ storePath })
    const peerEngine = new MemoryEngine({ domain: peerDomain })
    await peerDomain.withWriteLock(async () => {
      await peerEngine.recover()
      await peerEngine.write(
        {
          type: 'wiki',
          title: 'External peer note',
          body: 'Written from another process handle.',
        },
        ctx.workspace,
      )
    })

    const peerHits = (await getTool('memory_search').execute(
      { query: 'External peer note' },
      ctx,
    )) as { results: { title: string }[] }
    expect(peerHits.results.map((r) => r.title)).toContain('External peer note')
  })

  it('supports memory_read includeNonActive/supersedes, strict scope="workspace" filtering, and workspace-relative export/import paths', async () => {
    const { dataDir, getTool } = await setupHarness()
    const wsRoot = path.join(dataDir, 'ws-rel')
    await fs.mkdir(wsRoot, { recursive: true })
    const ctx = makeWorkspaceCtx(wsRoot)
    const approvedCtx = makeWorkspaceCtx(wsRoot, { approvedScopeOverride: true })

    await getTool('memory_write').execute(
      { type: 'preference', scope: 'global', title: 'Global style', body: 'Use concise logs.' },
      ctx,
    )
    const oldWs = (await getTool('memory_write').execute(
      { type: 'lesson', scope: 'workspace', title: 'Old ws rule', body: 'Use old API.' },
      ctx,
    )) as { id: string }

    // memory_list(scope="workspace") excludes global preferences; scope="current" includes both
    const wsOnly = (await getTool('memory_list').execute({ scope: 'workspace' }, ctx)) as {
      items: { title: string; scope: { kind: string } }[]
    }
    expect(wsOnly.items.map((item) => item.title)).toEqual(['Old ws rule'])

    const currentList = (await getTool('memory_list').execute({ scope: 'current' }, ctx)) as {
      items: { title: string }[]
    }
    expect(currentList.items.map((item) => item.title).sort()).toEqual([
      'Global style',
      'Old ws rule',
    ])

    // Create a pending proposal via organize prepare/commit with supersedes
    const orgPrep = (await getTool('memory_organize_prepare').execute({}, ctx)) as {
      dreamId: string
    }
    const orgComm = (await getTool('memory_organize_commit').execute(
      {
        dreamId: orgPrep.dreamId,
        memories: [
          {
            type: 'lesson',
            title: 'New ws rule',
            body: 'Use modern API everywhere.',
            confidence: 0.9,
            importance: 0.8,
            supersedes: [oldWs.id],
          },
        ],
      },
      ctx,
    )) as { createdIds: string[] }
    const pendingId = orgComm.createdIds[0]!

    // Default memory_read rejects pending proposals; includeNonActive=true returns full details + supersedes without incrementing useCount
    await expectOperationError(
      getTool('memory_read').execute({ id: pendingId }, ctx),
      'MEMORY_NOT_FOUND',
    )
    const pendingRead = (await getTool('memory_read').execute(
      { id: pendingId, includeNonActive: true },
      ctx,
    )) as { status: string; supersedes: string[]; useCount: number }
    expect(pendingRead.status).toBe('pending')
    expect(pendingRead.supersedes).toEqual([oldWs.id])
    expect(pendingRead.useCount).toBe(0)

    // Relative outputPath resolves against ctx.workspace.root (not process.cwd())
    const exported = (await getTool('memory_export').execute(
      { scope: 'workspace', outputPath: 'exports/rel-backup.json' },
      approvedCtx,
    )) as { outputPath: string; memoryCount: number }
    const expectedPath = path.resolve(wsRoot, 'exports/rel-backup.json')
    expect(exported.outputPath).toBe(expectedPath)
    expect(exported.memoryCount).toBe(2)
    const rawOnDisk = JSON.parse(await fs.readFile(expectedPath, 'utf8')) as {
      memories: unknown[]
    }
    expect(rawOnDisk.memories).toHaveLength(2)
  })
})
