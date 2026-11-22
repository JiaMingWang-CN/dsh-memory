/**
 * Memory settings section.
 *
 * Owns all data loading and Remote calls for the Settings page: workspace
 * selection, overview counters and index budget meter, four focused tabs
 * (Memories, Review, Import & Export, Settings), keyword search and pill
 * filters, detail/create/proposal modals with diff comparison and inline
 * unsaved-change confirmation. Presentational panels stay stateless.
 *
 * Data shape: a memory's workspace key is the normalized working-directory
 * path the Host stores, so the selector carries `WorkspaceInfo.key`; the live
 * workspace list arrives through the slot's `useWorkspaces` hook when present.
 * @module dsh-memory/client/MemorySection
 */
import * as React from 'react'
import type {
  DreamRun,
  ImportReport,
  MemoryConfig,
  MemoryExport,
  MemoryModelCatalog,
  MemoryOverview,
  MemoryRecord,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
  WorkspaceInfo,
} from './context.ts'
import { ConfigPanel } from './ConfigPanel.tsx'
import { diffLines } from './diff.ts'
import { errorText } from './errors.ts'
import { MemoryCreate } from './MemoryCreate.tsx'
import { MemoryDetail } from './MemoryDetail.tsx'
import type { MemoryDraft } from './MemoryEditor.tsx'
import { formatRelativeTime, MemoryList } from './MemoryList.tsx'
import { ReviewPanel } from './ReviewPanel.tsx'
import { TransferPanel, type TransferMapping, type TransferScope } from './TransferPanel.tsx'
import {
  WorkspaceFilter,
  isKnownWorkspace,
  pickDefaultWorkspace,
  readStoredWorkspace,
  resolveInitialWorkspace,
  workspaceKeyOf,
  writeStoredWorkspace,
} from './WorkspaceFilter.tsx'
import { formatMessage, t } from './locales.ts'
import { RPC_BULK_TIMEOUT_MS, rpc } from './rpc.ts'
import { clientContext, memoryRemote, remoteMountError, useLocaleVersion } from './runtime.ts'
import { MEMORY_CSS, MemoryErrorState } from './styles.ts'
import { Banner, Button, IconButton, Modal, PillGroup, Tabs, Tag } from './ui.tsx'

const h = React.createElement

/** Rows requested per page. */
const PAGE_SIZE = 25

/** Top-level tab identifiers. */
type MemoryTab = 'memories' | 'review' | 'transfer' | 'settings'

/** Comparison display modes in the proposal review modal. */
type CompareMode = 'diff' | 'side' | 'new'

/** One focused dialog: a memory's detail, a pending proposal, or a new memory. */
type MemoryDialog =
  | { kind: 'memory'; record: MemoryRecord; sources: MemorySourceRef[] }
  | { kind: 'proposal'; record: MemoryRecord; editing?: boolean }
  | { kind: 'create' }

/** The live Workspace snapshot fields this page reads. */
interface WorkspaceViewLike {
  workspaceId: string
  title: string
  path: string
  updatedAt: string
}

/** Props the Settings shell passes to a section entry. */
export interface MemorySectionProps {
  /**
   * Global snapshot selector over the Workspace controller's Client state.
   * Present in the live application; omitted by tests that provide a fake
   * `ctx.workspaces.list()` instead.
   */
  useWorkspaces?: <S>(selector: (snapshot: { items: readonly WorkspaceViewLike[] }) => S) => S
}

function readFallbackWorkspaces(): WorkspaceInfo[] {
  try {
    return clientContext().workspaces?.list() ?? []
  } catch {
    return []
  }
}

function toWorkspaceInfo(views: readonly WorkspaceViewLike[]): WorkspaceInfo[] {
  return views.map((view) => ({
    id: view.workspaceId,
    title: view.title,
    path: view.path,
    updatedAt: view.updatedAt,
    key: workspaceKeyOf(view.path),
  }))
}

/** Download one export document with a scope- and time-tagged file name. */
function downloadExport(payload: MemoryExport): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  anchor.download = `dsh-memory-export-${stamp}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** Refresh glyph for the toolbar. */
function RefreshIcon(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true },
    h('path', {
      d: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/** Search glyph for the list filter bar. */
function SearchIcon(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
    h('circle', {
      cx: 7,
      cy: 7,
      r: 4.5,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
    h('path', {
      d: 'M10.5 10.5L13.5 13.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
    }),
  )
}

/** Format bytes into a compact human-readable KB string. */
function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** Tone for the dream status indicator dot. */
function dreamTone(status: DreamRun['status']): 'success' | 'warn' | 'error' | 'idle' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'running' || status === 'queued') return 'warn'
  return 'idle'
}

/** The Memory page registered under `settings.section`. */
export function MemorySection(props: MemorySectionProps = {}): React.ReactElement {
  useLocaleVersion()
  const useWorkspaces = props.useWorkspaces
  const liveItems =
    useWorkspaces === undefined ? undefined : useWorkspaces((snapshot) => snapshot.items)
  const fallback = React.useMemo(
    () => (useWorkspaces === undefined ? readFallbackWorkspaces() : []),
    [useWorkspaces],
  )
  const workspaces = React.useMemo(
    () => (liveItems === undefined ? fallback : toWorkspaceInfo(liveItems)),
    [liveItems, fallback],
  )
  const mountError = remoteMountError()
  if (mountError !== undefined) {
    return h(MemoryErrorState, { message: mountError })
  }
  return h(MemorySectionBody, { workspaces })
}

interface BodyProps {
  workspaces: WorkspaceInfo[]
}

function MemorySectionBody(props: BodyProps): React.ReactElement {
  const remote = React.useMemo(() => memoryRemote(), [])
  const { workspaces } = props
  const [activeTab, setActiveTab] = React.useState<MemoryTab>('memories')
  const [chosenWorkspace, setChosenWorkspace] = React.useState<string | 'all' | undefined>(() =>
    readStoredWorkspace(),
  )
  const effectiveWorkspace = chosenWorkspace ?? pickDefaultWorkspace(workspaces) ?? 'all'
  const [type, setType] = React.useState<MemoryType | 'all'>('all')
  const [status, setStatus] = React.useState<MemoryStatus | 'all'>('all')
  const [searchInput, setSearchInput] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const [offset, setOffset] = React.useState(0)
  const [records, setRecords] = React.useState<MemoryRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [pending, setPending] = React.useState<MemoryRecord[]>([])
  const [overview, setOverview] = React.useState<MemoryOverview | undefined>(undefined)
  const [listError, setListError] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined)
  const [dialog, setDialog] = React.useState<MemoryDialog | undefined>(undefined)
  const [dirty, setDirty] = React.useState(false)
  const [confirmingClose, setConfirmingClose] = React.useState(false)
  const [compareMode, setCompareMode] = React.useState<CompareMode>('diff')
  const [busy, setBusy] = React.useState<string | undefined>(undefined)
  const [dreamRun, setDreamRun] = React.useState<DreamRun | null | undefined>(undefined)
  const [config, setConfig] = React.useState<MemoryConfig | undefined>(undefined)
  const [configRestart, setConfigRestart] = React.useState(false)
  const [configDirty, setConfigDirty] = React.useState(false)
  const [catalog, setCatalog] = React.useState<MemoryModelCatalog | undefined>(undefined)
  const [configRetryToken, setConfigRetryToken] = React.useState(0)
  const [superseded, setSuperseded] = React.useState<
    Array<{ id: string; record?: MemoryRecord; missing?: boolean }>
  >([])
  const [loadingSuperseded, setLoadingSuperseded] = React.useState(false)
  const silentReload = React.useRef(false)
  const hasLoaded = React.useRef(false)
  const detailSeq = React.useRef(0)
  const explicitAll = React.useRef(readStoredWorkspace() === 'all')
  const configLoaded = React.useRef(false)
  const catalogLoaded = React.useRef(false)

  const reload = React.useCallback((silent = false): void => {
    // The periodic refresh passes `silent` so a list that is already rendered
    // never flashes its loading state. Before the first load completes, never
    // suppress clearing `loading`.
    silentReload.current = silent && hasLoaded.current
    setReloadToken((value) => value + 1)
  }, [])

  const showError = (error: unknown): void => setActionError(errorText(error))

  // Auto-dismiss transient success notices so they never linger forever.
  React.useEffect(() => {
    if (notice === '' || typeof window === 'undefined') return undefined
    const timer = window.setTimeout(() => setNotice(''), 4_500)
    return () => window.clearTimeout(timer)
  }, [notice])

  // Debounce keyword search without firing an extra request on mount.
  React.useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === debouncedQuery) return undefined
    if (trimmed === '') {
      setDebouncedQuery('')
      return undefined
    }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 220)
    return () => window.clearTimeout(timer)
  }, [searchInput, debouncedQuery])

  // --- initial workspace resolution ---------------------------------------
  React.useEffect(() => {
    if (chosenWorkspace !== undefined) return undefined
    let cancelled = false
    void rpc(remote.activeWorkspace())
      .then((current) => {
        if (cancelled) return
        setChosenWorkspace(resolveInitialWorkspace(readStoredWorkspace(), current, workspaces))
      })
      .catch(() => {
        if (!cancelled) setChosenWorkspace(pickDefaultWorkspace(workspaces) ?? 'all')
      })
    return () => {
      cancelled = true
    }
  }, [chosenWorkspace, remote, workspaces])

  // A workspace can disappear from the registry, or workspaces may populate
  // after an initial fallback to 'all'; drop the stale/fallback choice so the
  // resolver can pick a live one unless the user explicitly chose 'all'.
  React.useEffect(() => {
    if (workspaces.length === 0) return
    if (chosenWorkspace === undefined) return
    if (chosenWorkspace === 'all' && !explicitAll.current) {
      setChosenWorkspace(undefined)
      return
    }
    if (!isKnownWorkspace(chosenWorkspace, workspaces)) setChosenWorkspace(undefined)
  }, [chosenWorkspace, workspaces])

  // Never keep a page offset that the current filter no longer supports.
  React.useEffect(() => {
    setOffset(0)
  }, [chosenWorkspace, type, status, debouncedQuery])

  // --- list + overview ----------------------------------------------------
  React.useEffect(() => {
    if (chosenWorkspace === undefined) return undefined
    let cancelled = false
    const silent = silentReload.current
    silentReload.current = false
    if (!silent && !hasLoaded.current) setLoading(true)
    const request = {
      workspaceKey: chosenWorkspace,
      limit: PAGE_SIZE,
      offset,
      ...(type === 'all' ? {} : { type }),
      ...(status === 'all' ? {} : { status }),
      ...(debouncedQuery === '' ? {} : { query: debouncedQuery }),
    }
    rpc(remote.list(request))
      .then((result) => {
        if (cancelled) return
        hasLoaded.current = true
        setRecords(result.items)
        setTotal(result.total)
        // An offset past the end (records were archived or filters changed
        // while paging) falls back to the first page instead of an empty list.
        if (result.items.length === 0 && offset > 0) setOffset(0)
        setListError('')
      })
      .catch((reason: unknown) => {
        if (!cancelled) setListError(errorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    rpc(remote.overview({ workspaceKey: chosenWorkspace }))
      .then((value) => {
        if (!cancelled) setOverview(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [remote, chosenWorkspace, type, status, debouncedQuery, offset, reloadToken])

  // Pending proposals are queried independently of the current page and filter:
  // a proposal beyond the visible page must still be reviewable.
  React.useEffect(() => {
    if (chosenWorkspace === undefined) return undefined
    let cancelled = false
    rpc(remote.list({ workspaceKey: chosenWorkspace, status: 'pending', limit: 50 }))
      .then((result) => {
        if (!cancelled) setPending(result.items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [remote, chosenWorkspace, reloadToken])

  // --- dreams -------------------------------------------------------------
  React.useEffect(() => {
    if (typeof remote.dreamStatus !== 'function') {
      setDreamRun(null)
      return undefined
    }
    let cancelled = false
    rpc(remote.dreamStatus())
      .then((value) => {
        if (!cancelled) setDreamRun(value)
      })
      .catch(() => {
        if (!cancelled) setDreamRun(null)
      })
    return () => {
      cancelled = true
    }
  }, [remote, reloadToken])

  // --- configuration ------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false
    if (!configLoaded.current) {
      rpc(remote.getConfig())
        .then((value) => {
          if (!cancelled) {
            configLoaded.current = true
            setConfig(value)
          }
        })
        .catch(() => undefined)
    }
    if (!catalogLoaded.current && typeof remote.modelCatalog === 'function') {
      rpc(remote.modelCatalog())
        .then((value) => {
          if (!cancelled) {
            catalogLoaded.current = true
            setCatalog(value)
          }
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [remote, configRetryToken])

  // --- superseded targets for proposal comparison -------------------------
  const proposalSupersedesKey =
    dialog?.kind === 'proposal' ? dialog.record.supersedes.join('\u0000') : ''
  const proposalId = dialog?.kind === 'proposal' ? dialog.record.id : ''
  React.useEffect(() => {
    if (dialog?.kind !== 'proposal' || dialog.record.supersedes.length === 0) {
      setSuperseded([])
      setLoadingSuperseded(false)
      return undefined
    }
    let cancelled = false
    const ids = dialog.record.supersedes
    setLoadingSuperseded(true)
    setSuperseded([])
    void Promise.all(
      ids.map(async (id) => {
        if (typeof remote.view !== 'function') return { id, missing: true as const }
        try {
          const view = await rpc(remote.view({ id }))
          return { id, record: view.record }
        } catch {
          return { id, missing: true as const }
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      setSuperseded(entries)
      setLoadingSuperseded(false)
    })
    return () => {
      cancelled = true
    }
  }, [remote, proposalId, proposalSupersedesKey])

  // A dream runs on the Host queue and can finish while this page stays open.
  // The Host does not forward a `memory/changed` event to the Client, so this
  // page polls while it is visible instead of subscribing to one.
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
    const refresh = (): void => {
      if (document.visibilityState === 'visible') reload(true)
    }
    const timer = window.setInterval(refresh, 8_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload])

  // --- actions ------------------------------------------------------------
  const resetDialogState = (): void => {
    setDirty(false)
    setConfirmingClose(false)
    setDialog(undefined)
  }

  const openMemory = async (id: string): Promise<void> => {
    const seq = ++detailSeq.current
    setSelectedId(id)
    setConfirmingClose(false)
    setDirty(false)
    try {
      const view = await rpc(remote.view({ id }))
      if (seq !== detailSeq.current) return
      setDialog({ kind: 'memory', record: view.record, sources: view.sources })
    } catch (reason) {
      if (seq === detailSeq.current) showError(reason)
    }
  }

  const openProposal = (record: MemoryRecord, editing = false): void => {
    setConfirmingClose(false)
    setDirty(false)
    setCompareMode('diff')
    setDialog({ kind: 'proposal', record, ...(editing ? { editing: true } : {}) })
  }

  const keepSelection = async (keepId?: string): Promise<void> => {
    reload()
    if (keepId === undefined) return
    const seq = ++detailSeq.current
    try {
      const view = await rpc(remote.view({ id: keepId }))
      if (seq !== detailSeq.current) return
      setSelectedId(view.record.id)
      setDialog((current) =>
        current !== undefined && current.kind === 'memory' && current.record.id === keepId
          ? { kind: 'memory', record: view.record, sources: view.sources }
          : current,
      )
    } catch {
      if (seq !== detailSeq.current) return
      setSelectedId(undefined)
      setDialog(undefined)
    }
  }

  const save = async (draft: MemoryDraft): Promise<void> => {
    await rpc(
      remote.update({
        id: draft.id,
        expectedContentRevision: draft.expectedContentRevision,
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        importance: draft.importance,
        pinned: draft.pinned,
      }),
    )
    setNotice(t('detail.updated'))
    await keepSelection(draft.id)
  }

  const remove = async (): Promise<void> => {
    const record = dialog?.kind === 'memory' ? dialog.record : undefined
    if (record === undefined) return
    setBusy('delete')
    try {
      await rpc(remote.delete({ id: record.id }))
      setDialog((current) =>
        current !== undefined && current.kind === 'memory' && current.record.id === record.id
          ? undefined
          : current,
      )
      setSelectedId((current) => (current === record.id ? undefined : current))
      setNotice(t('delete.archived'))
      reload()
    } finally {
      setBusy(undefined)
    }
  }

  const restore = async (): Promise<void> => {
    const record = dialog?.kind === 'memory' ? dialog.record : undefined
    if (record === undefined) return
    setBusy('restore')
    try {
      const updated = await rpc(remote.restore({ id: record.id }))
      setDialog((current) =>
        current !== undefined && current.kind === 'memory' && current.record.id === record.id
          ? { kind: 'memory', record: updated, sources: current.sources }
          : current,
      )
      await keepSelection(updated.id)
    } finally {
      setBusy(undefined)
    }
  }

  const advanceOrCloseProposal = (reviewedId: string): void => {
    const remaining = pending.filter((item) => item.id !== reviewedId)
    setDirty(false)
    setConfirmingClose(false)
    setDialog((current) => {
      if (
        current === undefined ||
        current.kind !== 'proposal' ||
        current.record.id !== reviewedId
      ) {
        return current
      }
      const currentIndex = pending.findIndex((item) => item.id === reviewedId)
      const nextRecord =
        remaining.length === 0
          ? undefined
          : remaining[Math.min(Math.max(currentIndex, 0), remaining.length - 1)]
      return nextRecord === undefined ? undefined : { kind: 'proposal', record: nextRecord }
    })
  }

  const reviewAction = async (id: string, action: 'accept' | 'reject'): Promise<void> => {
    setBusy('review')
    setActionError('')
    try {
      await rpc(remote.review({ id, action }))
      setNotice(action === 'accept' ? t('review.accepted') : t('review.rejected'))
      advanceOrCloseProposal(id)
      reload()
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(undefined)
    }
  }

  const saveAndAcceptProposal = async (draft: MemoryDraft): Promise<void> => {
    await rpc(
      remote.update({
        id: draft.id,
        expectedContentRevision: draft.expectedContentRevision,
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        importance: draft.importance,
        pinned: draft.pinned,
      }),
    )
    await rpc(remote.review({ id: draft.id, action: 'accept' }))
    setNotice(t('review.accepted'))
    advanceOrCloseProposal(draft.id)
    reload()
  }

  const createMemory = async (input: Parameters<typeof remote.create>[0]): Promise<void> => {
    await rpc(remote.create(input))
    resetDialogState()
    setNotice(t('create.created'))
    reload()
  }

  const transferScope: TransferScope =
    effectiveWorkspace === 'all' ? 'all' : { workspaceKey: effectiveWorkspace }
  const workspaceRoot =
    effectiveWorkspace === 'all'
      ? undefined
      : workspaces.find((workspace) => workspace.key === effectiveWorkspace)?.path

  const exportNow = async (scope: TransferScope): Promise<void> => {
    const payload = await rpc(remote.export({ scope }), RPC_BULK_TIMEOUT_MS)
    downloadExport(payload)
  }

  const importNow = async (
    mode: 'merge' | 'replace',
    payload: unknown,
    targetScope: TransferScope,
    mapping: TransferMapping,
  ): Promise<ImportReport> => {
    const report = await rpc(
      remote.import({
        payload: payload as MemoryExport,
        options: {
          mode,
          confirm: mode === 'replace',
          targetScope,
          mapping,
        },
      }),
      RPC_BULK_TIMEOUT_MS,
    )
    reload()
    return report
  }

  const runDream = async (): Promise<void> => {
    if (effectiveWorkspace === 'all') {
      setActionError(t('dream.needWorkspace'))
      return
    }
    setBusy('dream')
    setActionError('')
    try {
      const run = await rpc(
        remote.dream({
          scope: 'workspace',
          workspaceKey: effectiveWorkspace,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        }),
      )
      setDreamRun(run)
      setNotice(`${t('dream.queued')}: ${run.id}`)
      reload()
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(undefined)
    }
  }

  const cancelDream = async (): Promise<void> => {
    if (dreamRun === null || dreamRun === undefined) return
    if (typeof remote.cancelDream !== 'function') return
    setBusy('dream-cancel')
    try {
      await rpc(remote.cancelDream({ id: dreamRun.id }))
      reload()
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(undefined)
    }
  }

  const undoDream = async (): Promise<void> => {
    if (dreamRun === null || dreamRun === undefined) return
    if (typeof remote.undoDream !== 'function') return
    setBusy('dream-undo')
    setActionError('')
    try {
      const report = await rpc(remote.undoDream({ id: dreamRun.id }))
      setNotice(
        formatMessage('dream.undoResult', { undone: report.undone, skipped: report.skipped }),
      )
      reload()
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(undefined)
    }
  }

  const saveConfig = async (patch: Partial<MemoryConfig>): Promise<void> => {
    try {
      const result = await rpc(remote.updateConfig(patch))
      setActionError('')
      setConfig(result.config)
      setConfigRestart(result.restartRequired)
    } catch (reason) {
      showError(reason)
      throw reason
    }
  }

  const loadEfforts = React.useCallback(
    (provider: string, model: string) => rpc(remote.modelEfforts({ provider, model })),
    [remote],
  )

  const requestCloseDialog = (): void => {
    if (
      (dialog?.kind === 'memory' ||
        dialog?.kind === 'create' ||
        (dialog?.kind === 'proposal' && dialog.editing === true)) &&
      dirty &&
      !confirmingClose
    ) {
      setConfirmingClose(true)
      return
    }
    resetDialogState()
  }

  const clearFilters = (): void => {
    setType('all')
    setStatus('all')
    setSearchInput('')
    setDebouncedQuery('')
  }

  const pendingCount = overview?.counts.pending ?? pending.length
  const activeCount = overview?.counts.active ?? 0
  const archivedCount = overview?.counts.archived ?? 0
  const canDream = effectiveWorkspace !== 'all'
  const hasFilters = type !== 'all' || status !== 'all' || searchInput.trim() !== ''
  const indexBytes = overview?.index.bytes ?? 0
  const indexEntries = overview?.index.entries ?? 0
  const indexBudget = config?.indexMaxBytes ?? 4096
  const indexRatio = indexBudget > 0 ? Math.min(1, indexBytes / indexBudget) : 0
  const indexTone = indexRatio >= 1 ? 'error' : indexRatio >= 0.85 ? 'warn' : 'ok'

  const refreshAll = (): void => {
    setActionError('')
    setNotice('')
    if (!configLoaded.current || !catalogLoaded.current) {
      setConfigRetryToken((value) => value + 1)
    }
    reload()
  }

  const proposalIndex =
    dialog?.kind === 'proposal' ? pending.findIndex((item) => item.id === dialog.record.id) : -1

  const renderDirtyCloseConfirm = (): React.ReactElement | null =>
    !confirmingClose
      ? null
      : h(
          'div',
          {
            className: 'dsh-mem-confirm',
            role: 'alert',
            style: { margin: '12px 18px 0', borderRadius: 'var(--dsw-radius-md)' },
          },
          h('span', null, t('detail.dirtyClose')),
          h(
            Button,
            { variant: 'danger', size: 'sm', onClick: resetDialogState },
            t('detail.discardChanges'),
          ),
          h(
            Button,
            { variant: 'ghost', size: 'sm', onClick: () => setConfirmingClose(false) },
            t('detail.keepEditing'),
          ),
        )

  const renderDreamCard = (): React.ReactElement | null => {
    if (dreamRun === undefined) return null
    const isRunning =
      dreamRun !== null && (dreamRun.status === 'queued' || dreamRun.status === 'running')
    const runStamp =
      dreamRun === null ? undefined : formatRelativeTime(dreamRun.finishedAt ?? dreamRun.startedAt)
    const modelText =
      dreamRun === null
        ? ''
        : [
            dreamRun.provider !== '' && dreamRun.model !== ''
              ? `${dreamRun.provider} / ${dreamRun.model}`
              : dreamRun.model || dreamRun.provider || '—',
            dreamRun.reasoningEffort !== undefined && dreamRun.reasoningEffort !== ''
              ? `(${dreamRun.reasoningEffort})`
              : '',
          ]
            .filter((part) => part !== '')
            .join(' ')

    return h(
      'section',
      { className: 'dsh-mem-section-card' },
      h(
        'div',
        { className: 'dsh-mem-section-head' },
        h(
          'div',
          null,
          h(
            'h3',
            { className: 'dsh-mem-section-title' },
            t('dream.statusLabel'),
            dreamRun === null
              ? null
              : h(
                  Tag,
                  {
                    tone:
                      dreamRun.status === 'completed'
                        ? 'success'
                        : dreamRun.status === 'failed'
                          ? 'error'
                          : isRunning
                            ? 'warn'
                            : 'neutral',
                  },
                  h('span', {
                    className: 'dsh-mem-dot',
                    'data-tone': dreamTone(dreamRun.status),
                    ...(isRunning ? { 'data-pulse': 'true' } : {}),
                  }),
                  t(`dream.${dreamRun.status}`),
                ),
          ),
          dreamRun === null
            ? h(
                'p',
                { className: 'dsh-mem-hint', style: { marginTop: '4px' } },
                t('overview.noDream'),
              )
            : h('p', { className: 'dsh-mem-section-sub' }, dreamRun.id),
        ),
        dreamRun === null
          ? null
          : h(
              'div',
              { className: 'dsh-mem-actions' },
              isRunning
                ? h(
                    Button,
                    {
                      size: 'sm',
                      ...(busy === 'dream-cancel' ? { disabled: true } : {}),
                      onClick: () => {
                        void cancelDream()
                      },
                    },
                    t('dream.cancel'),
                  )
                : dreamRun.status === 'completed'
                  ? h(
                      Button,
                      {
                        size: 'sm',
                        ...(busy === 'dream-undo' ? { disabled: true } : {}),
                        onClick: () => {
                          void undoDream()
                        },
                      },
                      t('dream.undo'),
                    )
                  : null,
            ),
      ),
      dreamRun === null
        ? null
        : h(
            'dl',
            { className: 'dsh-mem-facts' },
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('dream.model')),
              h('dd', null, modelText),
            ),
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('dream.episodes')),
              h('dd', null, String(dreamRun.episodes)),
            ),
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('dream.committed')),
              h('dd', null, String(dreamRun.committed)),
            ),
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('dream.pendingCount')),
              h('dd', null, String(dreamRun.pending)),
            ),
            runStamp === undefined
              ? null
              : h(
                  'div',
                  { className: 'dsh-mem-fact' },
                  h('dt', null, t('dream.time')),
                  h('dd', { title: runStamp.full }, runStamp.short),
                ),
          ),
      dreamRun !== null && dreamRun.error !== undefined && dreamRun.error !== ''
        ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, dreamRun.error)
        : null,
    )
  }

  const renderProposalComparison = (proposal: MemoryRecord): React.ReactElement => {
    if (proposal.supersedes.length === 0 || compareMode === 'new') {
      return h(
        'div',
        { className: 'dsh-mem-body-box' },
        h('div', { className: 'dsh-mem-body' }, proposal.body),
      )
    }
    if (loadingSuperseded) {
      return h('p', { className: 'dsh-mem-hint' }, t('state.loading'))
    }
    if (compareMode === 'side') {
      return h(
        'div',
        { className: 'dsh-mem-compare' },
        h(
          'div',
          { className: 'dsh-mem-compare-pane' },
          h('span', { className: 'dsh-mem-compare-label' }, t('review.oldVersion')),
          ...superseded.map((entry) =>
            entry.record !== undefined
              ? h(
                  'div',
                  { key: entry.id, className: 'dsh-mem-detail-head' },
                  h('strong', { className: 'dsh-mem-proposal-title' }, entry.record.title),
                  entry.record.status === 'archived' ? h(Tag, null, t('status.archived')) : null,
                  h('div', { className: 'dsh-mem-body' }, entry.record.body),
                )
              : h(
                  'p',
                  { key: entry.id, className: 'dsh-mem-hint' },
                  `${entry.id}: ${t('review.supersededMissing')}`,
                ),
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-compare-pane' },
          h('span', { className: 'dsh-mem-compare-label' }, t('review.newVersion')),
          h('strong', { className: 'dsh-mem-proposal-title' }, proposal.title),
          h('div', { className: 'dsh-mem-body' }, proposal.body),
        ),
      )
    }
    // Line-by-line diff view against each superseded memory.
    return h(
      'div',
      { className: 'dsh-mem-stack' },
      ...superseded.map((entry) => {
        if (entry.record === undefined) {
          return h(
            'p',
            { key: entry.id, className: 'dsh-mem-hint' },
            `${entry.id}: ${t('review.supersededMissing')}`,
          )
        }
        const lines = diffLines(entry.record.body, proposal.body)
        return h(
          'div',
          { key: entry.id, className: 'dsh-mem-stack', style: { gap: '6px' } },
          h(
            'div',
            { className: 'dsh-mem-detail-tags' },
            h('span', { className: 'dsh-mem-compare-label' }, t('review.oldVersion')),
            h('strong', { className: 'dsh-mem-proposal-title' }, entry.record.title),
            entry.record.status === 'archived' ? h(Tag, null, t('status.archived')) : null,
          ),
          h(
            'div',
            { className: 'dsh-mem-diff' },
            lines.map((line, index) =>
              h(
                'div',
                {
                  key: `${entry.id}-${index}`,
                  className: 'dsh-mem-diff-line',
                  'data-kind': line.kind,
                },
                h(
                  'span',
                  { className: 'dsh-mem-diff-sign', 'aria-hidden': true },
                  line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ',
                ),
                h('span', null, line.text),
              ),
            ),
          ),
        )
      }),
    )
  }

  return h(
    'section',
    { className: 'dsh-mem-page' },
    h('style', null, MEMORY_CSS),
    // Page header with stable primary action buttons
    h(
      'div',
      { className: 'dsh-mem-header-row' },
      h(
        'div',
        { className: 'dsh-mem-head' },
        h('h2', { className: 'dsh-mem-title' }, t('settings.title')),
        h('p', { className: 'dsh-mem-intro' }, t('settings.description')),
      ),
      h(
        'div',
        { className: 'dsh-mem-header-actions' },
        h(
          Button,
          {
            variant: 'primary',
            size: 'sm',
            ...(effectiveWorkspace === 'all'
              ? { disabled: true, title: t('create.needWorkspace') }
              : {}),
            onClick: () => {
              setDirty(false)
              setConfirmingClose(false)
              setDialog({ kind: 'create' })
            },
          },
          t('common.new'),
        ),
        h(
          Button,
          {
            size: 'sm',
            ...(!canDream
              ? { disabled: true, title: t('dream.needWorkspace') }
              : busy === 'dream'
                ? { disabled: true }
                : {}),
            onClick: () => {
              void runDream()
            },
          },
          t('dream.runNow'),
        ),
        h(
          IconButton,
          {
            label: t('common.refresh'),
            onClick: refreshAll,
          },
          h(RefreshIcon),
        ),
      ),
    ),
    // Workspace context bar + clickable stats + index budget meter
    h(
      'div',
      { className: 'dsh-mem-toolbar' },
      h(WorkspaceFilter, {
        workspaces,
        value: effectiveWorkspace,
        hideWarning: true,
        onChange: (next) => {
          explicitAll.current = next === 'all'
          setChosenWorkspace(next)
          writeStoredWorkspace(next)
        },
      }),
      h('span', { className: 'dsh-mem-toolbar-spacer' }),
      h(
        'div',
        { className: 'dsh-mem-stats' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mem-stat',
            onClick: () => {
              setActiveTab('memories')
              setStatus('active')
            },
          },
          h('span', { className: 'dsh-mem-dot', 'data-tone': 'success' }),
          t('overview.active'),
          h('strong', null, String(activeCount)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mem-stat',
            onClick: () => setActiveTab('review'),
          },
          h('span', { className: 'dsh-mem-dot', 'data-tone': 'warn' }),
          t('overview.pending'),
          h('strong', null, String(pendingCount)),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-mem-stat',
            onClick: () => {
              setActiveTab('memories')
              setStatus('archived')
            },
          },
          h('span', { className: 'dsh-mem-dot', 'data-tone': 'idle' }),
          t('overview.archived'),
          h('strong', null, String(archivedCount)),
        ),
        overview === undefined
          ? null
          : h(
              'span',
              {
                className: 'dsh-mem-index-meter',
                title: `${t('overview.index')} · ${formatMessage('overview.indexEntries', { entries: indexEntries })}`,
              },
              h('span', null, t('overview.index')),
              h(
                'span',
                { className: 'dsh-mem-meter-track', 'aria-hidden': true },
                h('span', {
                  className: 'dsh-mem-meter-fill',
                  ...(indexTone === 'ok' ? {} : { 'data-tone': indexTone }),
                  style: { width: `${Math.round(indexRatio * 100)}%` },
                }),
              ),
              h('strong', null, `${formatKb(indexBytes)} / ${formatKb(indexBudget)}`),
            ),
      ),
    ),
    effectiveWorkspace === 'all'
      ? h('div', { className: 'dsh-mem-warning', role: 'note' }, t('workspace.warning'))
      : null,
    actionError === ''
      ? null
      : h(Banner, { tone: 'error', message: actionError, onDismiss: () => setActionError('') }),
    notice === ''
      ? null
      : h(Banner, { tone: 'notice', message: notice, onDismiss: () => setNotice('') }),
    // 4-tab navigation bar
    h(Tabs<MemoryTab>, {
      active: activeTab,
      onChange: setActiveTab,
      label: t('settings.title'),
      items: [
        { id: 'memories', label: t('tab.memories') },
        { id: 'review', label: t('tab.review'), badge: pendingCount },
        { id: 'transfer', label: t('tab.transfer') },
        { id: 'settings', label: t('tab.settings'), dot: configDirty },
      ],
    }),
    // Active tab panel
    activeTab === 'memories'
      ? h(
          'div',
          {
            className: 'dsh-mem-tabpanel',
            role: 'tabpanel',
            id: 'dsh-mem-panel-memories',
            'aria-labelledby': 'dsh-mem-tab-memories',
          },
          h(
            'div',
            { className: 'dsh-mem-card dsh-mem-list-full' },
            h(
              'div',
              { className: 'dsh-mem-pane-head' },
              h('span', { className: 'dsh-mem-pane-title' }, t('list.title')),
              h('span', { className: 'dsh-mem-count' }, formatMessage('list.total', { total })),
            ),
            h(
              'div',
              { className: 'dsh-mem-filters' },
              h(
                'div',
                { className: 'dsh-mem-search-row' },
                h(
                  'div',
                  { className: 'dsh-mem-search-wrap' },
                  h('span', { className: 'dsh-mem-search-icon' }, h(SearchIcon)),
                  h('input', {
                    type: 'search',
                    className: 'dsh-mem-search-input',
                    'aria-label': t('filter.search'),
                    placeholder: t('filter.searchPlaceholder'),
                    value: searchInput,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      setSearchInput(event.target.value),
                  }),
                  searchInput === ''
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-mem-search-clear',
                          'aria-label': t('common.clear'),
                          onClick: () => {
                            setSearchInput('')
                            setDebouncedQuery('')
                          },
                        },
                        '×',
                      ),
                ),
                hasFilters
                  ? h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'ghost',
                        onClick: clearFilters,
                      },
                      t('filter.clear'),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'dsh-mem-filter-bars' },
                h(PillGroup<MemoryType | 'all'>, {
                  label: t('filter.type'),
                  value: type,
                  options: [
                    { value: 'all', label: t('type.all') },
                    { value: 'lesson', label: t('type.lesson') },
                    { value: 'worklog', label: t('type.worklog') },
                    { value: 'wiki', label: t('type.wiki') },
                    { value: 'preference', label: t('type.preference') },
                  ],
                  onChange: setType,
                }),
                h(PillGroup<MemoryStatus | 'all'>, {
                  label: t('filter.status'),
                  value: status,
                  options: [
                    { value: 'all', label: t('status.all') },
                    { value: 'active', label: t('status.active') },
                    { value: 'pending', label: t('status.pending') },
                    { value: 'archived', label: t('status.archived') },
                  ],
                  onChange: setStatus,
                }),
              ),
            ),
            h(MemoryList, {
              records,
              ...(selectedId === undefined ? {} : { selectedId }),
              onSelect: (id: string) => {
                void openMemory(id)
              },
              ...(loading ? { loading: true } : {}),
              ...(listError === '' ? {} : { error: listError }),
              onRetry: () => reload(),
              filtered: hasFilters,
              onClearFilters: clearFilters,
            }),
            total > PAGE_SIZE
              ? h(
                  'div',
                  { className: 'dsh-mem-pager' },
                  h(
                    'span',
                    { className: 'dsh-mem-count' },
                    formatMessage('list.showing', {
                      from: total === 0 ? 0 : offset + 1,
                      to: offset + records.length,
                    }),
                  ),
                  h(
                    Button,
                    {
                      size: 'sm',
                      ...(offset === 0 ? { disabled: true } : {}),
                      onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)),
                    },
                    t('list.pagePrev'),
                  ),
                  h(
                    Button,
                    {
                      size: 'sm',
                      ...(offset + PAGE_SIZE >= total ? { disabled: true } : {}),
                      onClick: () => setOffset(offset + PAGE_SIZE),
                    },
                    t('list.pageNext'),
                  ),
                )
              : null,
          ),
        )
      : activeTab === 'review'
        ? h(
            'div',
            {
              className: 'dsh-mem-tabpanel',
              role: 'tabpanel',
              id: 'dsh-mem-panel-review',
              'aria-labelledby': 'dsh-mem-tab-review',
            },
            renderDreamCard(),
            h(ReviewPanel, {
              pending,
              ...(busy === 'review' ? { busy: true } : {}),
              onAccept: (id: string) => {
                void reviewAction(id, 'accept')
              },
              onReject: (id: string) => {
                void reviewAction(id, 'reject')
              },
              onEdit: (id: string) => {
                const target = pending.find((item) => item.id === id)
                if (target !== undefined) openProposal(target, true)
                else void openMemory(id)
              },
              onOpen: (record) => openProposal(record, false),
            }),
          )
        : activeTab === 'transfer'
          ? h(
              'div',
              {
                className: 'dsh-mem-tabpanel',
                role: 'tabpanel',
                id: 'dsh-mem-panel-transfer',
                'aria-labelledby': 'dsh-mem-tab-transfer',
              },
              h(TransferPanel, {
                scope: transferScope,
                workspaces,
                onExport: async (scope) => {
                  await exportNow(scope)
                },
                onImport: importNow,
              }),
            )
          : h(
              'div',
              {
                className: 'dsh-mem-tabpanel',
                role: 'tabpanel',
                id: 'dsh-mem-panel-settings',
                'aria-labelledby': 'dsh-mem-tab-settings',
              },
              config === undefined
                ? h(MemoryErrorState, {
                    message: t('state.error'),
                    onRetry: () => setConfigRetryToken((value) => value + 1),
                  })
                : h(ConfigPanel, {
                    config,
                    onSave: saveConfig,
                    restartNotice: configRestart,
                    ...(catalog === undefined ? {} : { catalog }),
                    loadEfforts,
                    onDirtyChange: setConfigDirty,
                  }),
            ),
    // Centered modal dialogs
    dialog === undefined
      ? null
      : dialog.kind === 'create'
        ? h(
            Modal,
            {
              title: t('create.title'),
              onClose: requestCloseDialog,
              closeLabel: t('common.close'),
              rawBody: true,
            },
            renderDirtyCloseConfirm(),
            h(MemoryCreate, {
              inModal: true,
              ...(effectiveWorkspace === 'all' ? {} : { workspaceKey: effectiveWorkspace }),
              ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
              onSave: createMemory,
              onCancel: requestCloseDialog,
              onDirtyChange: (next) => {
                setDirty(next)
                if (!next) setConfirmingClose(false)
              },
            }),
          )
        : dialog.kind === 'memory'
          ? h(
              Modal,
              {
                title: dialog.record.title,
                onClose: requestCloseDialog,
                closeLabel: t('common.close'),
                rawBody: true,
              },
              renderDirtyCloseConfirm(),
              h(MemoryDetail, {
                inModal: true,
                record: dialog.record,
                sources: dialog.sources,
                onSave: save,
                onDelete: remove,
                onRestore: restore,
                onReload: async () => {
                  const seq = ++detailSeq.current
                  const view = await rpc(remote.view({ id: dialog.record.id }))
                  if (seq !== detailSeq.current) return
                  setDialog({ kind: 'memory', record: view.record, sources: view.sources })
                },
                onDirtyChange: (next) => {
                  setDirty(next)
                  if (!next) setConfirmingClose(false)
                },
                ...(busy === 'delete' ? { deleting: true } : {}),
                ...(busy === 'restore' ? { restoring: true } : {}),
              }),
            )
          : dialog.editing === true
            ? h(
                Modal,
                {
                  title: dialog.record.title,
                  onClose: requestCloseDialog,
                  closeLabel: t('common.close'),
                  rawBody: true,
                },
                renderDirtyCloseConfirm(),
                h(MemoryDetail, {
                  inModal: true,
                  initialEditing: true,
                  record: dialog.record,
                  saveLabel: t('review.saveAndAccept'),
                  onSave: saveAndAcceptProposal,
                  onCancelEdit: () => {
                    setDirty(false)
                    setConfirmingClose(false)
                    setDialog({ kind: 'proposal', record: dialog.record, editing: false })
                  },
                  onReload: async () => {
                    const view = await rpc(remote.view({ id: dialog.record.id }))
                    setDialog({ kind: 'proposal', record: view.record, editing: false })
                  },
                  onDirtyChange: (next) => {
                    setDirty(next)
                    if (!next) setConfirmingClose(false)
                  },
                }),
              )
            : h(
                Modal,
                {
                  title: dialog.record.title,
                  onClose: requestCloseDialog,
                  closeLabel: t('common.close'),
                  headerExtra:
                    pending.length > 1 && proposalIndex >= 0
                      ? h(
                          'div',
                          { className: 'dsh-mem-actions' },
                          h(
                            'span',
                            { className: 'dsh-mem-count' },
                            formatMessage('review.position', {
                              current: proposalIndex + 1,
                              total: pending.length,
                            }),
                          ),
                          h(
                            Button,
                            {
                              size: 'sm',
                              variant: 'ghost',
                              ...(proposalIndex <= 0 ? { disabled: true } : {}),
                              onClick: () => {
                                const prev = pending[proposalIndex - 1]
                                if (prev !== undefined) openProposal(prev, false)
                              },
                            },
                            t('review.prev'),
                          ),
                          h(
                            Button,
                            {
                              size: 'sm',
                              variant: 'ghost',
                              ...(proposalIndex >= pending.length - 1 ? { disabled: true } : {}),
                              onClick: () => {
                                const next = pending[proposalIndex + 1]
                                if (next !== undefined) openProposal(next, false)
                              },
                            },
                            t('review.next'),
                          ),
                        )
                      : undefined,
                  footer: h(
                    'div',
                    { className: 'dsh-mem-footer-split' },
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        size: 'sm',
                        ...(busy === 'review' ? { disabled: true } : {}),
                        onClick: () => openProposal(dialog.record, true),
                      },
                      t('review.editBeforeAccept'),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mem-actions' },
                      h(
                        Button,
                        {
                          size: 'sm',
                          ...(busy === 'review' ? { disabled: true } : {}),
                          onClick: () => {
                            void reviewAction(dialog.record.id, 'reject')
                          },
                        },
                        t('review.reject'),
                      ),
                      h(
                        Button,
                        {
                          variant: 'primary',
                          size: 'sm',
                          ...(busy === 'review' ? { disabled: true } : {}),
                          onClick: () => {
                            void reviewAction(dialog.record.id, 'accept')
                          },
                        },
                        t('review.accept'),
                      ),
                    ),
                  ),
                },
                h(
                  'div',
                  { className: 'dsh-mem-detail' },
                  h(
                    'div',
                    { className: 'dsh-mem-section-head' },
                    h(
                      'div',
                      { className: 'dsh-mem-detail-tags' },
                      h(Tag, null, t(`type.${dialog.record.type}`)),
                      h(Tag, { tone: 'warn' }, t(`status.${dialog.record.status}`)),
                      h(
                        Tag,
                        null,
                        dialog.record.scope.kind === 'global'
                          ? t('scope.global')
                          : t('scope.workspace'),
                      ),
                    ),
                    dialog.record.supersedes.length === 0
                      ? null
                      : h(PillGroup<CompareMode>, {
                          label: t('review.diffView'),
                          value: compareMode,
                          options: [
                            { value: 'diff', label: t('review.diffView') },
                            { value: 'side', label: t('review.sideBySide') },
                            { value: 'new', label: t('review.proposedOnly') },
                          ],
                          onChange: setCompareMode,
                        }),
                  ),
                  renderProposalComparison(dialog.record),
                  dialog.record.supersedes.length === 0
                    ? null
                    : h(
                        'div',
                        { className: 'dsh-mem-detail-tags' },
                        h('span', { className: 'dsh-mem-count' }, `${t('review.supersedes')}:`),
                        ...dialog.record.supersedes.map((id) => h(Tag, { key: id }, id)),
                      ),
                  dialog.record.sourceEpisodeIds.length === 0
                    ? null
                    : h(
                        'div',
                        { className: 'dsh-mem-detail-tags' },
                        h('span', { className: 'dsh-mem-count' }, `${t('detail.sources')}:`),
                        ...dialog.record.sourceEpisodeIds.map((id) => h(Tag, { key: id }, id)),
                      ),
                  h(
                    'dl',
                    { className: 'dsh-mem-facts' },
                    h(
                      'div',
                      { className: 'dsh-mem-fact' },
                      h('dt', null, t('detail.importance')),
                      h('dd', null, String(dialog.record.importance)),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mem-fact' },
                      h('dt', null, t('detail.confidence')),
                      h('dd', null, String(dialog.record.confidence)),
                    ),
                    h(
                      'div',
                      { className: 'dsh-mem-fact' },
                      h('dt', null, t('detail.revision')),
                      h('dd', null, String(dialog.record.contentRevision)),
                    ),
                  ),
                ),
              ),
  )
}
