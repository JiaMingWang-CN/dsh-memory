/**
 * The user-facing `/memory` command.
 *
 * Subcommands: `status`, `search <query>`, `dream [--since <iso>]`,
 * `forget <id>`, and `export`. Every branch returns a stable {@link CommandResult}
 * so the command surface never throws a raw error at the UI.
 * @module memloom/host/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryService } from './service.ts'
import { workspaceIdentityOf } from './workspace.ts'

/** Result contract of one command invocation. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Minimal invocation shape the handler reads. */
export interface CommandInvocationLike {
  readonly commandId: string
  readonly agent: unknown
  readonly rawInput: string
}

/** Minimal definition shape the registry accepts. */
export interface CommandDefinitionLike {
  readonly definitionId?: unknown
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  handler(invocation: CommandInvocationLike): CommandResult | Promise<CommandResult>
}

/** The subset of `ctx.commands` this module uses. */
export interface CommandsLike {
  register(definition: CommandDefinitionLike): () => void
}

/** Fixed usage text for unknown or malformed subcommands. */
export const MEMORY_COMMAND_USAGE =
  'Usage: /memory status | search <query> | dream [--since <iso>] | organize | forget <id> | export'

/** Split off a command's first token and the remaining argument text. */
function split(raw: string): { sub: string; rest: string } {
  const trimmed = raw.trim()
  const space = trimmed.search(/\s/)
  if (space < 0) return { sub: trimmed, rest: '' }
  return { sub: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() }
}

/**
 * Register the `/memory` command on the calling context.
 * @param ctx - Plugin context carrying `ctx.commands`.
 * @param service - Memory service the command drives.
 * @returns A disposer that unregisters the command.
 */
export function registerMemoryCommands(ctx: Context, service: MemoryService): () => void {
  const commands = (ctx as unknown as { commands?: CommandsLike }).commands
  if (commands === undefined) return () => undefined
  return commands.register({
    definitionId: 'memloom/memory' as never,
    name: 'memory',
    description: 'Inspect and manage long-term memory.',
    input: { hint: 'status | search <query> | dream | organize | forget <id> | export' },
    handler: (invocation) => handle(invocation, ctx, service),
  })
}

async function handle(
  invocation: CommandInvocationLike,
  ctx: Context,
  service: MemoryService,
): Promise<CommandResult> {
  const { sub, rest } = split(invocation.rawInput)
  const workspace = await workspaceIdentityOf(ctx, invocation.agent)

  if (sub === '' || sub === 'status') {
    try {
      const snapshot = service.status()
      const recent = service.dreamRuns()[0]
      return {
        kind: 'success',
        text: JSON.stringify({
          ready: snapshot.ready,
          counts: snapshot.counts,
          dreamQueue: snapshot.dreamQueue,
          recentDream:
            recent === undefined
              ? null
              : { id: recent.id, status: recent.status, finishedAt: recent.finishedAt ?? null },
        }),
      }
    } catch (error) {
      return { kind: 'error', text: errorText(error) }
    }
  }

  if (sub === 'search') {
    if (rest === '') return { kind: 'error', text: MEMORY_COMMAND_USAGE }
    try {
      const result = service.search({
        query: rest,
        workspaceKey: workspace?.key ?? null,
        scope: 'auto',
      })
      return {
        kind: 'success',
        text: JSON.stringify({
          results: result.results.map((hit) => ({
            id: hit.id,
            type: hit.type,
            title: hit.title,
            snippet: hit.snippet,
          })),
          total: result.total,
        }),
      }
    } catch (error) {
      return { kind: 'error', text: errorText(error) }
    }
  }

  if (sub === 'forget') {
    if (rest === '') return { kind: 'error', text: MEMORY_COMMAND_USAGE }
    try {
      const record = await service.forget(
        rest,
        workspace?.key ?? null,
        undefined,
        invocation.commandId,
      )
      return {
        kind: 'success',
        text: JSON.stringify({ id: record.id, status: record.status }),
      }
    } catch (error) {
      return { kind: 'error', text: errorText(error) }
    }
  }

  if (sub === 'export') {
    try {
      const exported = service.exportSnapshot(
        workspace === null ? 'global' : { workspaceKey: workspace.key },
      )
      return {
        kind: 'success',
        text: JSON.stringify({
          exportedAt: exported.exportedAt,
          memories: exported.memories.length,
          episodes: exported.episodes.length,
        }),
      }
    } catch (error) {
      return { kind: 'error', text: errorText(error) }
    }
  }

  if (sub === 'dream') {
    const since = parseSince(rest)
    if (since === 'invalid') return { kind: 'error', text: MEMORY_COMMAND_USAGE }
    try {
      const dream = await service.enqueueDream({
        scope: workspace === null ? 'global' : 'workspace',
        workspace,
        agent: invocation.agent,
        ...(since === undefined ? {} : { since }),
      })
      return {
        kind: 'success',
        text: `Dream queued: ${dream.id} (status: ${dream.status})`,
      }
    } catch (error) {
      return { kind: 'error', text: errorText(error) }
    }
  }

  if (sub === 'organize') {
    try {
      const dream = await service.enqueueDream({
        scope: workspace === null ? 'global' : 'workspace',
        workspace,
        agent: invocation.agent,
        trigger: 'organize',
      })
      return {
        kind: 'success',
        text: `Organize queued: ${dream.id} (status: ${dream.status})`,
      }
    } catch (error) {
      return { kind: 'error', text: errorText(error) }
    }
  }

  return { kind: 'error', text: MEMORY_COMMAND_USAGE }
}

/** Parse `--since <iso>` out of the dream arguments. */
function parseSince(rest: string): string | undefined | 'invalid' {
  if (rest === '') return undefined
  const match = /^--since\s+(\S+)$/.exec(rest.trim())
  if (match === null) return 'invalid'
  const value = match[1]!
  if (Number.isNaN(Date.parse(value))) return 'invalid'
  return value
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code
    return code === undefined ? error.message : `${code}: ${error.message}`
  }
  return String(error)
}
