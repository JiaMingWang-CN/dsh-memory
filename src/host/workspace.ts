/**
 * Workspace identity derived from an Agent's effective working directory.
 *
 * Tools must never trust a model-supplied path: the workspace key always comes
 * from `ctx.workingDirectory.ensure(agent)`, normalized the same way for reads
 * and writes so a project cannot leak across workspaces.
 * @module memloom/host/workspace
 */
import type { Context } from '@deepseek-ai/cordis'
import { normalizeWorkspaceKey, type WorkspaceIdentity } from '../core/workspace.ts'

export { normalizeWorkspaceKey, type WorkspaceIdentity }

/** The subset of `ctx.workingDirectory` this plugin reads. */
export interface WorkingDirectoryService {
  ensure(agent: unknown): Promise<string>
}

/**
 * Resolve the current workspace identity for one Agent.
 * @param ctx - Host context carrying `workingDirectory`.
 * @param agent - Calling agent, when present.
 * @returns The identity, or `null` when the agent has no working directory.
 */
export async function workspaceIdentityOf(
  ctx: Context,
  agent: unknown,
): Promise<WorkspaceIdentity | null> {
  if (agent === undefined || agent === null) return null
  const service = (ctx as unknown as { workingDirectory?: WorkingDirectoryService })
    .workingDirectory
  if (service === undefined || typeof service.ensure !== 'function') return null
  const root = await service.ensure(agent)
  if (root === undefined || root === '') return null
  return { key: normalizeWorkspaceKey(root), root }
}
