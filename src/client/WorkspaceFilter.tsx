/**
 * Workspace selector for the Memory settings page.
 *
 * The page defaults to the most recently active workspace; choosing
 * "All accessible" is explicit and shows a cross-project warning because it can
 * reveal memories from other projects.
 *
 * A memory's stored workspace key is the normalized working-directory path
 * (`src/host/workspace.ts`), not the Workspace registry id, so the selector
 * carries {@link WorkspaceInfo.key} and falls back to the id only for callers
 * that bring synthetic rows.
 * @module dsh-memory/client/WorkspaceFilter
 */
import * as React from 'react'
import type { WorkspaceInfo } from './context.ts'
import { t } from './locales.ts'
import { Select } from './ui.tsx'

const h = React.createElement

/** Normalize a working-directory path exactly as the Host stores it. */
export function workspaceKeyOf(root: string): string {
  let path = root.trim().replace(/\\/g, '/')
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  if (/^[a-z]:$/i.test(path)) path = `${path}/`
  if (/^[a-z]:\//i.test(path) || path.startsWith('//')) path = path.toLowerCase()
  return path
}

/** Props accepted by {@link WorkspaceFilter}. */
export interface WorkspaceFilterProps {
  workspaces: WorkspaceInfo[]
  value?: string | 'all' | undefined
  onChange?: (value: string | 'all') => void
  /** Suppress the inline cross-project warning when the parent renders a dedicated banner. */
  hideWarning?: boolean
}

/** Stable memory key of one workspace row. */
export function workspaceKey(workspace: WorkspaceInfo): string {
  return workspace.key ?? workspaceKeyOf(workspace.path)
}

/** Local-storage key holding the last workspace the user picked. */
export const WORKSPACE_STORAGE_KEY = 'dsh-memory.workspace'

/** Read the remembered workspace choice, if the browser allows storage. */
export function readStoredWorkspace(): string | 'all' | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (raw === null || raw === '') return undefined
    return raw === 'all' ? 'all' : raw
  } catch {
    return undefined
  }
}

/** Persist one explicit workspace choice; storage failures are ignored. */
export function writeStoredWorkspace(value: string | 'all'): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, value)
  } catch {
    // A browser that blocks storage must not break the page.
  }
}

/** Whether a value names a workspace this page can show. */
export function isKnownWorkspace(
  value: string | 'all',
  workspaces: readonly WorkspaceInfo[],
): boolean {
  return value === 'all' || workspaces.some((workspace) => workspaceKey(workspace) === value)
}

/**
 * Resolve the first workspace to show.
 *
 * A workspace the user picked explicitly wins, so their choice survives a
 * reload. Otherwise the most recently active session's workspace wins, which is
 * the current project rather than whatever the registry updated last. The
 * registry's most-recent row is only a fallback.
 */
export function resolveInitialWorkspace(
  stored: string | 'all' | undefined,
  current: string | null,
  workspaces: readonly WorkspaceInfo[],
): string | 'all' {
  if (workspaces.length === 0) {
    if (stored !== undefined) return stored
    if (current !== null && current !== '') return current
    return 'all'
  }
  if (stored !== undefined && isKnownWorkspace(stored, workspaces)) return stored
  if (current !== null && current !== '' && isKnownWorkspace(current, workspaces)) return current
  return pickDefaultWorkspace(workspaces) ?? 'all'
}

/**
 * Pick the most recently active workspace key.
 * @param workspaces - Workspace rows with optional `updatedAt`.
 * @returns The newest workspace key, or undefined when there are none.
 */
export function pickDefaultWorkspace(workspaces: readonly WorkspaceInfo[]): string | undefined {
  let best: WorkspaceInfo | undefined
  for (const workspace of workspaces) {
    if (best === undefined) {
      best = workspace
      continue
    }
    if ((workspace.updatedAt ?? '') > (best.updatedAt ?? '')) best = workspace
  }
  return best === undefined ? undefined : workspaceKey(best)
}

/**
 * Render the workspace selector.
 * @param props - Workspace rows and the selected value.
 * @returns The selector element.
 */
export function WorkspaceFilter(props: WorkspaceFilterProps): React.ReactElement {
  const selected = props.value ?? pickDefaultWorkspace(props.workspaces) ?? 'all'
  const options = [
    ...props.workspaces.map((workspace) => ({
      value: workspaceKey(workspace),
      label: workspace.title ?? workspace.path,
    })),
    { value: 'all', label: t('workspace.all') },
  ]
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
    h(Select, {
      label: t('filter.workspace'),
      value: selected,
      options,
      ...(props.onChange === undefined ? {} : { onChange: props.onChange }),
    }),
    selected === 'all' && props.hideWarning !== true
      ? h('div', { className: 'dsh-mem-warning', role: 'note' }, t('workspace.warning'))
      : null,
  )
}
