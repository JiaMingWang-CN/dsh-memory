/**
 * Host-agnostic workspace identity and path normalization.
 * @module memloom/core/workspace
 */

/** Stable workspace identity stored in a memory scope. */
export interface WorkspaceIdentity {
  /** Normalized key used for filtering and equality. */
  key: string
  /** Absolute root path as resolved for the caller. */
  root: string
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
