/**
 * Single-client management workspace reusing `src/client/` components alongside
 * desktop-specific Dreams & Audit, Cross-Client Migration, and AGY/DSH Config panels.
 * @module memloom/desktop/renderer/SingleClientView
 */
import * as React from 'react'
import { diffLines } from '../../client/diff.ts'
import type { MemoryCreateInput, WorkspaceInfo } from '../../client/context.ts'
import { formatMessage, t } from '../../client/locales.ts'
import { MemoryCreate } from '../../client/MemoryCreate.tsx'
import { MemoryDetail } from '../../client/MemoryDetail.tsx'
import type { MemoryDraft } from '../../client/MemoryEditor.tsx'
import { MemoryList } from '../../client/MemoryList.tsx'
import { ReviewPanel } from '../../client/ReviewPanel.tsx'
import { MemoryErrorState } from '../../client/styles.ts'
import {
  TransferPanel,
  type TransferMapping,
  type TransferScope,
} from '../../client/TransferPanel.tsx'
import { Banner, Button, IconButton, Modal, PillGroup, Tabs, Tag } from '../../client/ui.tsx'
import {
  WorkspaceFilter,
  pickDefaultWorkspace,
  workspaceKeyOf,
} from '../../client/WorkspaceFilter.tsx'
import type { MemoryConfig } from '../../core/config.ts'
import type { MemoryOverviewResult, WorkspaceSummary } from '../../core/engine.ts'
import type { ImportReport, MemoryExport } from '../../core/exchange.ts'
import type { MemoryRecord, MemorySourceRef, MemoryStatus, MemoryType } from '../../shared/types.ts'
import type { DesktopBridgeApi, IpcResult } from '../ipc-contract.ts'
import type { DesktopClientConfigResult, DesktopClientInfo } from '../multi-service.ts'
import { DesktopConfigPanel } from './DesktopConfigPanel.tsx'
import { DreamAuditPanel } from './DreamAuditPanel.tsx'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'

const h = React.createElement
const Fragment = React.Fragment

const PAGE_SIZE = 25

type SingleTab = 'memories' | 'review' | 'dreamAudit' | 'transfer' | 'settings'
type CompareMode = 'diff' | 'side' | 'new'

type SingleDialog =
  | { kind: 'memory'; record: MemoryRecord; sources: MemorySourceRef[] }
  | { kind: 'proposal'; record: MemoryRecord; editing?: boolean }
  | { kind: 'create' }

export interface SingleClientViewProps {
  readonly bridge: DesktopBridgeApi
  readonly client: DesktopClientInfo
  readonly refreshToken: number
  readonly banners?: React.ReactNode
  readonly openMemoryRequest?: { readonly id: string; readonly seq: number }
  readonly onClientDataChanged: () => void | Promise<void>
  readonly onOpenMigrationForRecord: (clientId: string, record: MemoryRecord) => void
  readonly onOpenMigrationWizard: (clientId: string) => void
  readonly onExternalChange: () => void
  readonly onManageClient: (client: DesktopClientInfo) => void
}

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

function SearchIcon(): React.ReactElement {
  return h(
    'svg',
    { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
    h('circle', { cx: 7, cy: 7, r: 4.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
    h('path', {
      d: 'M10.5 10.5L13.5 13.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
    }),
  )
}

function formatKb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function toWorkspaceInfos(rows: readonly WorkspaceSummary[]): WorkspaceInfo[] {
  return rows.map((row) => ({
    id: row.key,
    path: row.root,
    key: row.key,
    updatedAt: row.updatedAt,
  }))
}

/** Read-only memory detail view rendered when the selected client is protected (`!writable`). */
function ReadOnlyMemoryDetail(props: {
  readonly record: MemoryRecord
  readonly sources: readonly MemorySourceRef[]
  readonly onMigrate: () => void
}): React.ReactElement {
  const { record, sources } = props
  return h(
    Fragment,
    null,
    h(
      'div',
      { className: 'dsh-mem-modal-body' },
      h(
        'div',
        { className: 'dsh-mem-detail' },
        h(
          'div',
          { className: 'dsh-mem-warning', role: 'note' },
          t('desktop.detail.readonlyNotice'),
        ),
        h(
          'div',
          { className: 'dsh-mem-detail-tags' },
          h(Tag, null, t(`type.${record.type}`)),
          h(
            Tag,
            {
              tone:
                record.status === 'pending'
                  ? 'warn'
                  : record.status === 'active'
                    ? 'success'
                    : 'neutral',
            },
            t(`status.${record.status}`),
          ),
          h(Tag, null, record.scope.kind === 'global' ? t('scope.global') : record.scope.root),
          record.pinned ? h(Tag, { tone: 'warn' }, t('detail.pinned')) : null,
        ),
        h(
          'div',
          { className: 'dsh-mem-body-box' },
          h('div', { className: 'dsh-mem-body' }, record.body),
        ),
        h(
          'dl',
          { className: 'dsh-mem-facts' },
          h(
            'div',
            { className: 'dsh-mem-fact' },
            h('dt', null, t('detail.importance')),
            h('dd', null, String(record.importance)),
          ),
          h(
            'div',
            { className: 'dsh-mem-fact' },
            h('dt', null, t('detail.confidence')),
            h('dd', null, String(record.confidence)),
          ),
          h(
            'div',
            { className: 'dsh-mem-fact' },
            h('dt', null, t('detail.matchCount')),
            h('dd', null, String(record.matchCount)),
          ),
          h(
            'div',
            { className: 'dsh-mem-fact' },
            h('dt', null, t('detail.useCount')),
            h('dd', null, String(record.useCount)),
          ),
          h(
            'div',
            { className: 'dsh-mem-fact' },
            h('dt', null, t('detail.revision')),
            h('dd', null, String(record.contentRevision)),
          ),
        ),
        record.tags.length > 0
          ? h(
              'div',
              { className: 'dsh-mem-detail-tags' },
              h('span', { className: 'dsh-mem-count' }, `${t('detail.tags')}:`),
              ...record.tags.map((tag) => h(Tag, { key: tag, tone: 'accent' }, tag)),
            )
          : null,
        sources.length > 0
          ? h(
              'div',
              { className: 'dsh-mem-detail-tags' },
              h('span', { className: 'dsh-mem-count' }, `${t('detail.sources')}:`),
              ...sources.map((s, idx) => h(Tag, { key: `${s.sessionId}-${idx}` }, s.sessionId)),
            )
          : null,
      ),
    ),
    h(
      'div',
      { className: 'dsh-mem-modal-footer' },
      h(Button, { size: 'sm', onClick: props.onMigrate }, t('desktop.detail.openMigration')),
    ),
  )
}

/**
 * Full single-client management surface.
 */
export function SingleClientView(props: SingleClientViewProps): React.ReactElement {
  const { bridge, client, refreshToken } = props
  const clientId = client.id

  const [activeTab, setActiveTab] = React.useState<SingleTab>('memories')
  const [workspaces, setWorkspaces] = React.useState<WorkspaceInfo[]>([])
  const [chosenWorkspace, setChosenWorkspace] = React.useState<string | 'all'>('all')
  const [type, setType] = React.useState<MemoryType | 'all'>('all')
  const [status, setStatus] = React.useState<MemoryStatus | 'all'>('all')
  const [searchInput, setSearchInput] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const [offset, setOffset] = React.useState(0)

  const [records, setRecords] = React.useState<MemoryRecord[]>([])
  const [total, setTotal] = React.useState(0)
  const [pending, setPending] = React.useState<MemoryRecord[]>([])
  const [overview, setOverview] = React.useState<MemoryOverviewResult | undefined>(undefined)
  const [configResult, setConfigResult] = React.useState<DesktopClientConfigResult | undefined>(
    undefined,
  )
  const [configDirty, setConfigDirty] = React.useState(false)

  const [loading, setLoading] = React.useState(true)
  const [listError, setListError] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [localReload, setLocalReload] = React.useState(0)
  const [selectedId, setSelectedId] = React.useState<string | undefined>(undefined)

  const [dialog, setDialog] = React.useState<SingleDialog | undefined>(undefined)
  const [dirty, setDirty] = React.useState(false)
  const [confirmingClose, setConfirmingClose] = React.useState(false)
  const [confirmPermanentDelete, setConfirmPermanentDelete] = React.useState(false)
  const [compareMode, setCompareMode] = React.useState<CompareMode>('diff')
  const [superseded, setSuperseded] = React.useState<
    Array<{ id: string; record?: MemoryRecord; missing?: boolean }>
  >([])
  const [loadingSuperseded, setLoadingSuperseded] = React.useState(false)
  const [busy, setBusy] = React.useState<string | undefined>(undefined)
  const [createCustomWorkspace, setCreateCustomWorkspace] = React.useState<
    { key: string; root: string } | undefined
  >(undefined)

  const detailSeq = React.useRef(0)
  const lastHandledOpenSeq = React.useRef(0)

  const isStoreBlocked =
    !client.enabled ||
    client.health === 'corrupted' ||
    client.health === 'unreadable' ||
    (client.health === 'missing' && !client.allowInitializeWhenMissing)

  const reload = React.useCallback((): void => {
    setLocalReload((v) => v + 1)
  }, [])

  // Reset per-client transient UI when switching clients
  React.useEffect(() => {
    setActiveTab('memories')
    setChosenWorkspace('all')
    setType('all')
    setStatus('all')
    setSearchInput('')
    setDebouncedQuery('')
    setOffset(0)
    setSelectedId(undefined)
    setDialog(undefined)
    setDirty(false)
    setConfirmingClose(false)
    setConfirmPermanentDelete(false)
    setActionError('')
    setNotice('')
    setConfigDirty(false)
  }, [clientId])

  React.useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === debouncedQuery) return undefined
    if (trimmed === '') {
      setDebouncedQuery('')
      return undefined
    }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 200)
    return () => window.clearTimeout(timer)
  }, [searchInput, debouncedQuery])

  React.useEffect(() => {
    setOffset(0)
  }, [chosenWorkspace, type, status, debouncedQuery])

  // Load workspaces
  React.useEffect(() => {
    if (isStoreBlocked) {
      setWorkspaces([])
      return undefined
    }
    if (client.health === 'missing') {
      setWorkspaces([])
      return undefined
    }
    let cancelled = false
    void bridge.memory
      .listWorkspaces({ clientId })
      .then((res) => {
        if (cancelled) return
        const infos = toWorkspaceInfos(unwrapIpc(res))
        setWorkspaces(infos)
        setChosenWorkspace((current) => {
          if (current !== 'all' && infos.some((w) => (w.key ?? w.path) === current)) {
            return current
          }
          return 'all'
        })
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
    return () => {
      cancelled = true
    }
  }, [bridge, clientId, client.health, isStoreBlocked, refreshToken, localReload])

  // Load config
  React.useEffect(() => {
    if (!client.enabled) return undefined
    let cancelled = false
    void bridge.memory
      .getConfig({ clientId })
      .then((res) => {
        if (!cancelled) setConfigResult(unwrapIpc(res))
      })
      .catch(() => {
        if (!cancelled) setConfigResult(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [bridge, clientId, client.enabled, refreshToken, localReload])

  // Load list, overview, and pending proposals
  React.useEffect(() => {
    if (isStoreBlocked) {
      setLoading(false)
      setRecords([])
      setTotal(0)
      setPending([])
      setOverview(undefined)
      return undefined
    }
    if (client.health === 'missing') {
      setLoading(false)
      setRecords([])
      setTotal(0)
      setPending([])
      setOverview({
        workspaceKey: chosenWorkspace,
        counts: { active: 0, pending: 0, archived: 0, stored: 0 },
        pendingReview: 0,
        recentDream: null,
        index: { entries: 0, bytes: 0 },
      })
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setListError('')
    Promise.all([
      bridge.memory.list({
        clientId,
        workspaceKey: chosenWorkspace,
        limit: PAGE_SIZE,
        offset,
        management: true,
        ...(type === 'all' ? {} : { type }),
        ...(status === 'all' ? {} : { status }),
        ...(debouncedQuery === '' ? {} : { query: debouncedQuery }),
      }),
      bridge.memory.overview({ clientId, workspaceKey: chosenWorkspace }),
      bridge.memory.list({
        clientId,
        workspaceKey: chosenWorkspace,
        status: 'pending',
        limit: 50,
        management: true,
      }),
    ])
      .then(([listRes, overviewRes, pendingRes]) => {
        if (cancelled) return
        const listVal = unwrapIpc(listRes)
        setRecords(listVal.items)
        setTotal(listVal.total)
        setOverview(unwrapIpc(overviewRes))
        setPending(unwrapIpc(pendingRes).items)
      })
      .catch((reason) => {
        if (cancelled) return
        if (isExternalChangeError(reason)) props.onExternalChange()
        setListError(desktopErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    bridge,
    clientId,
    client.health,
    isStoreBlocked,
    chosenWorkspace,
    type,
    status,
    debouncedQuery,
    offset,
    refreshToken,
    localReload,
  ])

  // Load superseded records when viewing a proposal
  const proposalId = dialog?.kind === 'proposal' ? dialog.record.id : ''
  const proposalSupersedesKey =
    dialog?.kind === 'proposal' ? dialog.record.supersedes.join('\u0000') : ''
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
        try {
          const res = unwrapIpc(await bridge.memory.view({ clientId, id }))
          return { id, record: res.record }
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
  }, [bridge, clientId, proposalId, proposalSupersedesKey])

  const openMemory = React.useCallback(
    async (id: string): Promise<void> => {
      const seq = ++detailSeq.current
      setSelectedId(id)
      setDirty(false)
      setConfirmingClose(false)
      setConfirmPermanentDelete(false)
      try {
        const res = unwrapIpc(await bridge.memory.view({ clientId, id }))
        if (seq !== detailSeq.current) return
        setDialog({ kind: 'memory', record: res.record, sources: res.sources })
      } catch (reason) {
        if (seq === detailSeq.current) {
          if (isExternalChangeError(reason)) props.onExternalChange()
          setActionError(desktopErrorText(reason))
        }
      }
    },
    [bridge, clientId, props],
  )

  // Handle cross-view "Open in client" requests from AggregateView
  React.useEffect(() => {
    const req = props.openMemoryRequest
    if (req === undefined || req.seq === lastHandledOpenSeq.current || isStoreBlocked) return
    lastHandledOpenSeq.current = req.seq
    setActiveTab('memories')
    void openMemory(req.id)
  }, [props.openMemoryRequest, isStoreBlocked, openMemory])

  const resetDialogState = (): void => {
    setDirty(false)
    setConfirmingClose(false)
    setConfirmPermanentDelete(false)
    setDialog(undefined)
  }

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

  const wrapIpcError = (error: unknown): never => {
    if (isExternalChangeError(error)) {
      props.onExternalChange()
    }
    if (error !== null && typeof error === 'object' && 'code' in error) {
      const errObj = error as { code: string; message?: string; details?: Record<string, unknown> }
      throw {
        ...errObj,
        message: desktopErrorText(error),
      }
    }
    throw error
  }

  const unwrapOrNotify = <T,>(res: IpcResult<T>): T => {
    if (!res.ok) return wrapIpcError(res.error)
    return res.value
  }

  const saveMemory = async (draft: MemoryDraft): Promise<void> => {
    unwrapOrNotify(
      await bridge.memory.update({
        clientId,
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
    const viewRes = await bridge.memory.view({ clientId, id: draft.id })
    if (viewRes.ok) {
      setDialog({ kind: 'memory', record: viewRes.value.record, sources: viewRes.value.sources })
    }
    reload()
    await props.onClientDataChanged()
  }

  const archiveMemory = async (): Promise<void> => {
    if (dialog?.kind !== 'memory') return
    const id = dialog.record.id
    setBusy('delete')
    try {
      unwrapOrNotify(await bridge.memory.delete({ clientId, id }))
      resetDialogState()
      setSelectedId((cur) => (cur === id ? undefined : cur))
      setNotice(t('delete.archived'))
      reload()
      await props.onClientDataChanged()
    } finally {
      setBusy(undefined)
    }
  }

  const permanentDeleteMemory = async (): Promise<void> => {
    if (dialog?.kind !== 'memory') return
    const id = dialog.record.id
    setBusy('delete')
    setActionError('')
    try {
      unwrapOrNotify(
        await bridge.memory.delete({
          clientId,
          id,
          permanent: true,
          confirm: true,
          actor: 'user',
        }),
      )
      resetDialogState()
      setSelectedId((cur) => (cur === id ? undefined : cur))
      reload()
      await props.onClientDataChanged()
    } catch (reason) {
      setActionError(desktopErrorText(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const restoreMemory = async (): Promise<void> => {
    if (dialog?.kind !== 'memory') return
    const id = dialog.record.id
    setBusy('restore')
    try {
      const restored = unwrapOrNotify(await bridge.memory.restore({ clientId, id }))
      setDialog((cur) =>
        cur?.kind === 'memory' && cur.record.id === id
          ? { kind: 'memory', record: restored, sources: cur.sources }
          : cur,
      )
      reload()
      await props.onClientDataChanged()
    } finally {
      setBusy(undefined)
    }
  }

  const createMemory = async (input: MemoryCreateInput): Promise<void> => {
    unwrapOrNotify(
      await bridge.memory.create({
        clientId,
        ...input,
      }),
    )
    resetDialogState()
    setNotice(t('create.created'))
    reload()
    await props.onClientDataChanged()
  }

  const openProposal = (record: MemoryRecord, editing = false): void => {
    setConfirmingClose(false)
    setDirty(false)
    setCompareMode('diff')
    setDialog({ kind: 'proposal', record, ...(editing ? { editing: true } : {}) })
  }

  const reviewAction = async (id: string, action: 'accept' | 'reject'): Promise<void> => {
    if (!client.writable) return
    setBusy('review')
    setActionError('')
    try {
      unwrapOrNotify(await bridge.memory.review({ clientId, id, action }))
      setNotice(action === 'accept' ? t('review.accepted') : t('review.rejected'))
      resetDialogState()
      reload()
      await props.onClientDataChanged()
    } catch (reason) {
      setActionError(desktopErrorText(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const saveAndAcceptProposal = async (draft: MemoryDraft): Promise<void> => {
    unwrapOrNotify(
      await bridge.memory.update({
        clientId,
        id: draft.id,
        expectedContentRevision: draft.expectedContentRevision,
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        importance: draft.importance,
        pinned: draft.pinned,
      }),
    )
    unwrapOrNotify(await bridge.memory.review({ clientId, id: draft.id, action: 'accept' }))
    setNotice(t('review.accepted'))
    resetDialogState()
    reload()
    await props.onClientDataChanged()
  }

  const exportMemoriesToFile = async (scope: TransferScope): Promise<void> => {
    const exported = unwrapOrNotify(await bridge.memory.export({ clientId, scope }))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const savedPath = unwrapOrNotify(
      await bridge.dialog.saveExportJson({
        defaultFileName: `memloom-${client.id}-${stamp}.json`,
        content: JSON.stringify(exported, null, 2),
      }),
    )
    if (savedPath !== null) {
      setNotice(formatMessage('desktop.transfer.exportSaved', { path: savedPath }))
    }
  }

  const importMemoriesFromPayload = async (
    mode: 'merge' | 'replace',
    payload: unknown,
    targetScope: TransferScope,
    mapping: TransferMapping,
  ): Promise<ImportReport> => {
    const report = unwrapOrNotify(
      await bridge.memory.import({
        clientId,
        payload: payload as MemoryExport,
        options: {
          mode,
          confirm: mode === 'replace',
          targetScope,
          mapping,
        },
      }),
    )
    reload()
    await props.onClientDataChanged()
    return report
  }

  const saveConfig = async (patch: Partial<MemoryConfig>): Promise<void> => {
    const nextConfig = unwrapOrNotify(await bridge.memory.updateConfig({ clientId, patch }))
    setConfigResult(nextConfig)
    setNotice(t('config.saved'))
  }

  const pickWorkspaceForCreate = async (): Promise<void> => {
    try {
      const dir = unwrapIpc(await bridge.dialog.pickDirectory())
      if (dir !== null && dir !== '') {
        setCreateCustomWorkspace({ key: workspaceKeyOf(dir), root: dir })
      }
    } catch (reason) {
      setActionError(desktopErrorText(reason))
    }
  }

  const statusBadge = !client.enabled
    ? { tone: 'neutral' as const, text: t('desktop.status.disabled') }
    : client.health === 'corrupted'
      ? { tone: 'error' as const, text: t('desktop.status.corrupted') }
      : client.health === 'unreadable'
        ? { tone: 'error' as const, text: t('desktop.status.unreadable') }
        : client.health === 'missing'
          ? { tone: 'neutral' as const, text: t('desktop.status.missing') }
          : client.writable
            ? {
                tone: client.dshProtected ? ('warn' as const) : ('success' as const),
                text: client.dshProtected
                  ? t('desktop.status.forceUnlocked')
                  : t('desktop.status.writable'),
              }
            : { tone: 'warn' as const, text: t('desktop.status.readonly') }

  const renderBlockedShell = (content: React.ReactNode): React.ReactElement =>
    h(
      'section',
      { className: 'memloom-workspace-view' },
      h(
        'header',
        { className: 'memloom-workspace-header' },
        h(
          'div',
          { className: 'memloom-view-bar' },
          h(
            'div',
            { className: 'memloom-view-bar-main' },
            h(
              'div',
              { className: 'memloom-view-title-row' },
              h('h2', { className: 'dsh-mem-title' }, client.name),
              h(Tag, { tone: statusBadge.tone }, statusBadge.text),
              h(Tag, null, t(`desktop.kind.${client.kind}`)),
            ),
            h('p', { className: 'memloom-meta-path', title: client.storePath }, client.storePath),
          ),
          h(
            'div',
            { className: 'dsh-mem-header-actions' },
            h(
              Button,
              {
                size: 'sm',
                onClick: () => props.onManageClient(client),
              },
              t('desktop.clientManage'),
            ),
            h(
              IconButton,
              {
                label: t('common.refresh'),
                onClick: () => {
                  void props.onClientDataChanged()
                  reload()
                },
              },
              h(RefreshIcon),
            ),
          ),
        ),
      ),
      props.banners ?? null,
      h(
        'div',
        { className: 'memloom-content-scroll' },
        h('div', { className: 'memloom-content-inner' }, content),
      ),
    )

  if (!client.enabled) {
    return renderBlockedShell(
      h(
        'div',
        { className: 'dsh-mem-section-card' },
        h('h3', { className: 'dsh-mem-section-title' }, t('desktop.client.disabledTitle')),
        h('p', { className: 'dsh-mem-hint' }, t('desktop.client.disabledDesc')),
        h(
          'div',
          { className: 'dsh-mem-actions' },
          h(
            Button,
            { size: 'sm', onClick: () => props.onManageClient(client) },
            t('desktop.clientManage'),
          ),
        ),
      ),
    )
  }

  if (client.health === 'corrupted' || client.health === 'unreadable') {
    return renderBlockedShell(
      h(
        'div',
        { className: 'dsh-mem-section-card' },
        h(MemoryErrorState, {
          message: `${t('desktop.client.corruptTitle')}${client.healthDetail ? `: ${client.healthDetail}` : ''}`,
          onRetry: () => {
            void props.onClientDataChanged()
            reload()
          },
        }),
      ),
    )
  }

  if (client.health === 'missing' && !client.allowInitializeWhenMissing) {
    return renderBlockedShell(
      h(
        'div',
        { className: 'dsh-mem-section-card' },
        h('h3', { className: 'dsh-mem-section-title' }, t('desktop.client.missingDshTitle')),
        h('p', { className: 'dsh-mem-hint' }, t('desktop.client.missingDshDesc')),
        h('p', { className: 'memloom-meta-path' }, client.storePath),
      ),
    )
  }

  const pendingCount = overview?.counts.pending ?? pending.length
  const activeCount = overview?.counts.active ?? 0
  const archivedCount = overview?.counts.archived ?? 0
  const indexBytes = overview?.index.bytes ?? 0
  const indexEntries = overview?.index.entries ?? 0
  const indexBudget = configResult?.config?.indexMaxBytes ?? 4096
  const indexRatio = indexBudget > 0 ? Math.min(1, indexBytes / indexBudget) : 0
  const indexTone = indexRatio >= 1 ? 'error' : indexRatio >= 0.85 ? 'warn' : 'ok'
  const hasFilters = type !== 'all' || status !== 'all' || searchInput.trim() !== ''

  const defaultCreateWs =
    createCustomWorkspace ??
    (chosenWorkspace !== 'all'
      ? (() => {
          const found = workspaces.find((w) => (w.key ?? w.path) === chosenWorkspace)
          return found !== undefined
            ? { key: found.key ?? workspaceKeyOf(found.path), root: found.path }
            : undefined
        })()
      : (() => {
          const fallbackKey = pickDefaultWorkspace(workspaces)
          const found = workspaces.find((w) => (w.key ?? w.path) === fallbackKey)
          return found !== undefined
            ? { key: found.key ?? workspaceKeyOf(found.path), root: found.path }
            : undefined
        })())

  const transferScope: TransferScope =
    chosenWorkspace === 'all' ? 'all' : { workspaceKey: chosenWorkspace }

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
          { key: entry.id, className: 'dsh-mem-diff' },
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
        )
      }),
    )
  }

  return h(
    'section',
    { className: 'memloom-workspace-view' },
    // Fixed Top Header & Category Tabs
    h(
      'header',
      { className: 'memloom-workspace-header' },
      h(
        'div',
        { className: 'memloom-view-bar' },
        h(
          'div',
          { className: 'memloom-view-bar-main' },
          h(
            'div',
            { className: 'memloom-view-title-row' },
            h('h2', { className: 'dsh-mem-title' }, client.name),
            h(Tag, { tone: statusBadge.tone }, statusBadge.text),
            h(Tag, null, t(`desktop.kind.${client.kind}`)),
          ),
          h('p', { className: 'memloom-meta-path', title: client.storePath }, client.storePath),
        ),
        h(
          'div',
          { className: 'dsh-mem-header-actions' },
          h(
            Button,
            {
              variant: 'primary',
              size: 'sm',
              disabled: !client.writable,
              ...(client.writable ? {} : { title: t('desktop.detail.readonlyNotice') }),
              onClick: () => {
                setCreateCustomWorkspace(undefined)
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
              onClick: () => props.onManageClient(client),
            },
            t('desktop.clientManage'),
          ),
          h(
            IconButton,
            {
              label: t('common.refresh'),
              onClick: () => {
                void props.onClientDataChanged()
                reload()
              },
            },
            h(RefreshIcon),
          ),
        ),
      ),
      h(
        'div',
        { className: 'memloom-category-bar' },
        h(Tabs<SingleTab>, {
          active: activeTab,
          onChange: setActiveTab,
          label: client.name,
          items: [
            { id: 'memories', label: t('tab.memories') },
            { id: 'review', label: t('tab.review'), badge: pendingCount },
            { id: 'dreamAudit', label: t('desktop.tab.dreamAudit') },
            { id: 'transfer', label: t('desktop.tab.transfer') },
            { id: 'settings', label: t('tab.settings'), dot: configDirty },
          ],
        }),
      ),
    ),

    props.banners ?? null,

    actionError !== '' || notice !== ''
      ? h(
          'div',
          { className: 'memloom-inline-banners' },
          actionError !== ''
            ? h(Banner, {
                tone: 'error',
                message: actionError,
                onDismiss: () => setActionError(''),
              })
            : null,
          notice !== ''
            ? h(Banner, { tone: 'notice', message: notice, onDismiss: () => setNotice('') })
            : null,
        )
      : null,

    // Scrollable Memory Content Area
    h(
      'div',
      { className: 'memloom-content-scroll' },
      h(
        'div',
        { className: 'memloom-content-inner' },
        client.health === 'missing'
          ? h(
              'div',
              { className: 'dsh-mem-notice', role: 'note' },
              `${t('desktop.client.missingInitTitle')}: ${t('desktop.client.missingInitDesc')}`,
            )
          : null,

        // Context & Stats Toolbar
        h(
          'div',
          { className: 'dsh-mem-toolbar' },
          h(WorkspaceFilter, {
            workspaces,
            value: chosenWorkspace,
            hideWarning: true,
            onChange: setChosenWorkspace,
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
            h(
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

        // Tab 1: Memories
        activeTab === 'memories'
          ? h(
              'div',
              { className: 'dsh-mem-tabpanel', role: 'tabpanel', id: 'dsh-mem-panel-memories' },
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
                            onClick: () => {
                              setType('all')
                              setStatus('all')
                              setSearchInput('')
                              setDebouncedQuery('')
                            },
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
                  onSelect: (id) => {
                    void openMemory(id)
                  },
                  loading,
                  ...(listError === '' ? {} : { error: listError }),
                  onRetry: reload,
                  filtered: hasFilters,
                  onClearFilters: () => {
                    setType('all')
                    setStatus('all')
                    setSearchInput('')
                    setDebouncedQuery('')
                  },
                }),
                total > PAGE_SIZE
                  ? h(
                      'div',
                      { className: 'dsh-mem-pager' },
                      h(
                        'span',
                        { className: 'dsh-mem-count' },
                        formatMessage('list.showing', {
                          from: offset + 1,
                          to: offset + records.length,
                        }),
                      ),
                      h(
                        Button,
                        {
                          size: 'sm',
                          disabled: offset === 0,
                          onClick: () => setOffset(Math.max(0, offset - PAGE_SIZE)),
                        },
                        t('list.pagePrev'),
                      ),
                      h(
                        Button,
                        {
                          size: 'sm',
                          disabled: offset + PAGE_SIZE >= total,
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
                { className: 'dsh-mem-tabpanel', role: 'tabpanel', id: 'dsh-mem-panel-review' },
                !client.writable
                  ? h(
                      'div',
                      { className: 'dsh-mem-warning', role: 'note' },
                      t('desktop.review.readonlyNotice'),
                    )
                  : null,
                h(ReviewPanel, {
                  pending,
                  busy: !client.writable || busy === 'review',
                  onAccept: (id) => {
                    void reviewAction(id, 'accept')
                  },
                  onReject: (id) => {
                    void reviewAction(id, 'reject')
                  },
                  onEdit: (id) => {
                    if (!client.writable) return
                    const target = pending.find((item) => item.id === id)
                    if (target !== undefined) openProposal(target, true)
                  },
                  onOpen: (record) => openProposal(record, false),
                }),
              )
            : activeTab === 'dreamAudit'
              ? h(
                  'div',
                  {
                    className: 'dsh-mem-tabpanel',
                    role: 'tabpanel',
                    id: 'dsh-mem-panel-dreamAudit',
                  },
                  h(DreamAuditPanel, {
                    bridge,
                    clientId,
                    writable: client.writable,
                    refreshToken,
                    onDataChanged: async () => {
                      reload()
                      await props.onClientDataChanged()
                    },
                    onExternalChange: props.onExternalChange,
                  }),
                )
              : activeTab === 'transfer'
                ? h(
                    'div',
                    {
                      className: 'dsh-mem-tabpanel',
                      role: 'tabpanel',
                      id: 'dsh-mem-panel-transfer',
                    },
                    h(
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
                            t('desktop.migrate.title'),
                          ),
                          h(
                            'p',
                            { className: 'dsh-mem-section-sub' },
                            t('desktop.transfer.wizardDesc'),
                          ),
                        ),
                        h(
                          Button,
                          {
                            variant: 'primary',
                            size: 'sm',
                            onClick: () => props.onOpenMigrationWizard(clientId),
                          },
                          t('desktop.transfer.openWizard'),
                        ),
                      ),
                    ),
                    !client.writable
                      ? h(
                          'div',
                          { className: 'dsh-mem-stack' },
                          h(
                            'div',
                            { className: 'dsh-mem-warning', role: 'note' },
                            t('desktop.transfer.readonlyImportNotice'),
                          ),
                          h(
                            'section',
                            { className: 'dsh-mem-section-card' },
                            h(
                              'h3',
                              { className: 'dsh-mem-section-title' },
                              t('transfer.exportTitle'),
                            ),
                            h('p', { className: 'dsh-mem-section-sub' }, t('transfer.exportDesc')),
                            h(
                              'div',
                              { className: 'dsh-mem-actions' },
                              h(
                                Button,
                                {
                                  variant: 'primary',
                                  onClick: () => {
                                    void exportMemoriesToFile(transferScope)
                                  },
                                },
                                t('transfer.export'),
                              ),
                            ),
                          ),
                        )
                      : h(TransferPanel, {
                          scope: transferScope,
                          workspaces,
                          onExport: exportMemoriesToFile,
                          onImport: importMemoriesFromPayload,
                        }),
                  )
                : h(
                    'div',
                    {
                      className: 'dsh-mem-tabpanel',
                      role: 'tabpanel',
                      id: 'dsh-mem-panel-settings',
                    },
                    configResult === undefined
                      ? h(MemoryErrorState, { message: t('state.error'), onRetry: reload })
                      : h(DesktopConfigPanel, {
                          configResult,
                          onSave: saveConfig,
                          onDirtyChange: setConfigDirty,
                        }),
                  ),
      ),
    ),

    // Modals
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
            h(
              'div',
              {
                className: 'dsh-mem-actions',
                style: { padding: '10px 18px 0', justifyContent: 'space-between' },
              },
              h(
                'span',
                { className: 'dsh-mem-hint' },
                formatMessage('desktop.create.workspaceHint', {
                  scope: defaultCreateWs?.root ?? t('scope.global'),
                }),
              ),
              h(
                Button,
                {
                  size: 'sm',
                  onClick: () => {
                    void pickWorkspaceForCreate()
                  },
                },
                t('desktop.create.pickWorkspace'),
              ),
            ),
            h(MemoryCreate, {
              inModal: true,
              ...(defaultCreateWs !== undefined
                ? { workspaceKey: defaultCreateWs.key, workspaceRoot: defaultCreateWs.root }
                : {}),
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
              !client.writable
                ? h(ReadOnlyMemoryDetail, {
                    record: dialog.record,
                    sources: dialog.sources,
                    onMigrate: () => {
                      const targetRecord = dialog.record
                      resetDialogState()
                      props.onOpenMigrationForRecord(clientId, targetRecord)
                    },
                  })
                : h(
                    Fragment,
                    null,
                    h(MemoryDetail, {
                      inModal: true,
                      record: dialog.record,
                      sources: dialog.sources,
                      onSave: saveMemory,
                      onDelete: archiveMemory,
                      onRestore: restoreMemory,
                      onReload: async () => {
                        const seq = ++detailSeq.current
                        const res = unwrapIpc(
                          await bridge.memory.view({ clientId, id: dialog.record.id }),
                        )
                        if (seq !== detailSeq.current) return
                        setDialog({ kind: 'memory', record: res.record, sources: res.sources })
                      },
                      onDirtyChange: (next) => {
                        setDirty(next)
                        if (!next) setConfirmingClose(false)
                      },
                      ...(busy === 'delete' ? { deleting: true } : {}),
                      ...(busy === 'restore' ? { restoring: true } : {}),
                    }),
                    h(
                      'div',
                      {
                        className: 'dsh-mem-actions',
                        style: {
                          padding: '8px 18px 12px',
                          borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                          justifyContent: 'space-between',
                        },
                      },
                      confirmPermanentDelete
                        ? h(
                            'div',
                            {
                              className: 'dsh-mem-confirm',
                              role: 'alert',
                              style: { flex: '1 1 auto' },
                            },
                            h('span', null, t('desktop.detail.permanentDeleteConfirm')),
                            h(
                              Button,
                              {
                                variant: 'danger',
                                size: 'sm',
                                disabled: busy === 'delete',
                                onClick: () => {
                                  void permanentDeleteMemory()
                                },
                              },
                              t('common.confirm'),
                            ),
                            h(
                              Button,
                              {
                                variant: 'ghost',
                                size: 'sm',
                                onClick: () => setConfirmPermanentDelete(false),
                              },
                              t('common.cancel'),
                            ),
                          )
                        : h(
                            Fragment,
                            null,
                            h(
                              Button,
                              {
                                variant: 'danger',
                                size: 'sm',
                                disabled: busy === 'delete',
                                onClick: () => setConfirmPermanentDelete(true),
                              },
                              t('desktop.detail.permanentDelete'),
                            ),
                            h(
                              Button,
                              {
                                size: 'sm',
                                onClick: () => {
                                  const targetRecord = dialog.record
                                  resetDialogState()
                                  props.onOpenMigrationForRecord(clientId, targetRecord)
                                },
                              },
                              t('desktop.detail.openMigration'),
                            ),
                          ),
                    ),
                  ),
            )
          : dialog.editing === true && client.writable
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
                    const res = unwrapIpc(
                      await bridge.memory.view({ clientId, id: dialog.record.id }),
                    )
                    setDialog({ kind: 'proposal', record: res.record, editing: false })
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
                  ...(client.writable
                    ? {
                        footer: h(
                          'div',
                          { className: 'dsh-mem-footer-split' },
                          h(
                            Button,
                            {
                              variant: 'ghost',
                              size: 'sm',
                              disabled: busy === 'review',
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
                                disabled: busy === 'review',
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
                                disabled: busy === 'review',
                                onClick: () => {
                                  void reviewAction(dialog.record.id, 'accept')
                                },
                              },
                              t('review.accept'),
                            ),
                          ),
                        ),
                      }
                    : {}),
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
                ),
              ),
  )
}
