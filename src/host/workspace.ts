/**
 * Workspace identity derived from an Agent's effective working directory.
 *
 * Tools must never trust a model-supplied path: the workspace key always comes
 * from `ctx.workingDirectory.ensure(agent)`, normalized the same way for reads
 * and writes so a project cannot leak across workspaces.
 * @module dsh-memory/host/workspace
 */
import type { Context } from '@deepseek-ai/cordis'

/** Stable workspace identity stored in a memory scope. */
export interface WorkspaceIdentity {
  /** Normalized key used for filtering and equality. */
  key: string
  /** Absolute root path as resolved for the agent. */
  root: string
}

/** The subset of `ctx.workingDirectory` this plugin reads. */
export interface WorkingDirectoryService {
  ensure(agent: unknown): Promise<string>
}

/**
 * Normalize a working-directory path into a stable workspace key.
 *
 * Backslashes become forward slashes, trailing separators are removed, and
 * Windows absolute paths (drive-letter or UNC) are lower-cased so casing
 * differences resolve to one workspace.
 * @param root - Absolute working-directory path.
 * @returns The normalized workspace key.
 */
export function normalizeWorkspaceKey(root: string): string {
  let path = root.trim().replace(/\\/g, '/')
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  if (/^[a-z]:$/i.test(path)) path = `${path}/`
  if (/^[a-z]:\//i.test(path) || path.startsWith('//')) path = path.toLowerCase()
  return path
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
