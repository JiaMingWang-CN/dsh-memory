/**
 * Unified Memories Workbench supporting both cross-host federated search
 * (`activeHostId === 'all'`) and single-host full CRUD, batch actions,
 * and Master-Detail inspection with safe Markdown rendering.
 * @module memloom/desktop/renderer/MemoriesView
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import type { WorkspaceSummary } from '../../core/engine.ts'
import type {
  MemoryOwnership,
  MemoryRecord,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
} from '../../shared/types.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type {
  AggregateSearchItem,
  DesktopClientInfo,
  MigrationSourceSelection,
} from '../multi-service.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'
import {
  Button,
  Checkbox,
  Dropdown,
  EmptyBlock,
  HostLogo,
  HostTag,
  Icons,
  MarkdownProse,
  Modal,
  SegmentedControl,
  Switch,
  TextField,
  TypeTag,
  hostColorVars,
  typeColorVar,
} from './ui.tsx'

const h = React.createElement
const PAGE_SIZE = 25

export interface MemoriesViewProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly activeHostId: string | 'all'
  readonly onSelectHost: (hostId: string | 'all', focusRecordId?: string) => void
  readonly refreshToken: number
  readonly banners?: React.ReactNode
  readonly openMemoryRequest?: {
    readonly clientId: string
    readonly id: string
    readonly seq: number
  }
  readonly onDataChanged: () => Promise<void>
  readonly onExternalChange: () => void
  readonly onOpenMigration: (sourceClientId: string, selection?: MigrationSourceSelection) => void
  readonly onNotify: (message: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void
}

interface UnifiedMemoryItem {
  readonly clientId: string
  readonly clientName: string
  readonly clientKind: DesktopClientInfo['kind']
  readonly writable: boolean
  readonly record: MemoryRecord
  readonly score?: number
}

interface EditorModalState {
  readonly mode: 'create' | 'edit'
  readonly clientId: string
  readonly record?: MemoryRecord
}

function normalizeWorkspaceKey(rawRoot: string): string {
  return rawRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function formatStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatHostCompact(client: DesktopClientInfo): string {
  if (client.kind === 'agy') return 'AGY'
  if (client.kind === 'dsh') {
    return client.profileName !== undefined && client.profileName !== ''
      ? `DSH/${client.profileName}`
      : 'DSH'
  }
  return client.name
}

function isClientBlocked(client: DesktopClientInfo): boolean {
  return (
    !client.enabled ||
    client.health === 'corrupted' ||
    client.health === 'unreadable' ||
    (client.health === 'missing' && !client.allowInitializeWhenMissing)
  )
}

export function MemoriesView(props: MemoriesViewProps): React.ReactElement {
  const { bridge, clients, activeHostId, refreshToken } = props
  const isAllHosts = activeHostId === 'all'
  const activeClient = isAllHosts ? undefined : clients.find((c) => c.id === activeHostId)

  const [searchInput, setSearchInput] = React.useState('')
  const [debouncedQuery, setDebouncedQuery] = React.useState('')
  const [workspaceFilter, setWorkspaceFilter] = React.useState<string>('all')
  const [typeFilter, setTypeFilter] = React.useState<MemoryType | 'all'>('all')
  const [statusFilter, setStatusFilter] = React.useState<MemoryStatus | 'all'>('all')
  const [ownershipFilter, setOwnershipFilter] = React.useState<MemoryOwnership | 'all'>('all')
  const [offset, setOffset] = React.useState(0)

  const [workspaces, setWorkspaces] = React.useState<WorkspaceSummary[]>([])
  const [items, setItems] = React.useState<UnifiedMemoryItem[]>([])
  const [total, setTotal] = React.useState(0)
  const [skippedClients, setSkippedClients] = React.useState<
    readonly {
      readonly id: string
      readonly name: string
      readonly health: string
      readonly detail?: string
    }[]
  >([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [localReload, setLocalReload] = React.useState(0)

  const [selectedKey, setSelectedKey] = React.useState<string | undefined>(undefined)
  const [inspected, setInspected] = React.useState<
    | {
        readonly clientId: string
        readonly record: MemoryRecord
        readonly sources: readonly MemorySourceRef[]
      }
    | undefined
  >(undefined)
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(() => new Set())
  const [editorModal, setEditorModal] = React.useState<EditorModalState | undefined>(undefined)
  const [confirmPermanent, setConfirmPermanent] = React.useState<
    { readonly clientId: string; readonly record: MemoryRecord } | undefined
  >(undefined)
  const [busyAction, setBusyAction] = React.useState(false)

  const lastHandledOpenSeq = React.useRef(0)

  React.useEffect(() => {
    setOffset(0)
    setCheckedIds(new Set())
    setWorkspaceFilter('all')
  }, [activeHostId])

  React.useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === debouncedQuery) return undefined
    if (trimmed === '') {
      setDebouncedQuery('')
      return undefined
    }
    const timer = window.setTimeout(() => setDebouncedQuery(trimmed), 180)
    return () => window.clearTimeout(timer)
  }, [searchInput, debouncedQuery])

  React.useEffect(() => {
    setOffset(0)
  }, [workspaceFilter, typeFilter, statusFilter, ownershipFilter, debouncedQuery])

  // Load workspaces for active scope
  React.useEffect(() => {
    let cancelled = false
    if (isAllHosts) {
      void bridge.aggregate
        .listWorkspaces()
        .then((res) => {
          if (!cancelled) setWorkspaces(unwrapIpc(res).items)
        })
        .catch(() => {
          if (!cancelled) setWorkspaces([])
        })
    } else if (
      activeClient !== undefined &&
      !isClientBlocked(activeClient) &&
      activeClient.health !== 'missing'
    ) {
      void bridge.memory
        .listWorkspaces({ clientId: activeClient.id })
        .then((res) => {
          if (!cancelled) setWorkspaces(unwrapIpc(res))
        })
        .catch(() => {
          if (!cancelled) setWorkspaces([])
        })
    } else {
      setWorkspaces([])
    }
    return () => {
      cancelled = true
    }
  }, [bridge, isAllHosts, activeClient, refreshToken, localReload])

  // Load memories list (federated or single-client)
  React.useEffect(() => {
    let cancelled = false
    if (!isAllHosts && activeClient !== undefined && isClientBlocked(activeClient)) {
      setLoading(false)
      setItems([])
      setTotal(0)
      setSkippedClients([])
      setLoadError('')
      return undefined
    }
    if (!isAllHosts && activeClient !== undefined && activeClient.health === 'missing') {
      setLoading(false)
      setItems([])
      setTotal(0)
      setSkippedClients([])
      setLoadError('')
      return undefined
    }

    setLoading(true)
    setLoadError('')

    if (isAllHosts) {
      void bridge.aggregate
        .search({
          ...(debouncedQuery !== '' ? { query: debouncedQuery } : {}),
          workspaceKey: workspaceFilter,
          ...(typeFilter !== 'all' ? { types: [typeFilter] } : {}),
          ...(statusFilter !== 'all' ? { statuses: [statusFilter] } : {}),
          limit: PAGE_SIZE,
          offset,
        })
        .then((res) => {
          if (cancelled) return
          const val = unwrapIpc(res)
          const mapped: UnifiedMemoryItem[] = val.items.map((it: AggregateSearchItem) => ({
            clientId: it.clientId,
            clientName: it.clientName,
            clientKind: it.clientKind,
            writable: it.writable,
            record: it.record,
            score: it.normalizedScore,
          }))
          setItems(mapped)
          setTotal(val.total)
          setSkippedClients(val.skippedClients)
        })
        .catch((err) => {
          if (!cancelled) setLoadError(desktopErrorText(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    } else if (activeClient !== undefined) {
      const localOwnershipFilter = ownershipFilter !== 'all'
      void bridge.memory
        .list({
          clientId: activeClient.id,
          workspaceKey: workspaceFilter,
          ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          ...(debouncedQuery !== '' ? { query: debouncedQuery } : {}),
          limit: localOwnershipFilter ? 200 : PAGE_SIZE,
          offset: localOwnershipFilter ? 0 : offset,
          management: true,
        })
        .then((res) => {
          if (cancelled) return
          const val = unwrapIpc(res)
          const filtered = localOwnershipFilter
            ? val.items.filter((r) => r.ownership === ownershipFilter)
            : val.items
          const pageItems = localOwnershipFilter
            ? filtered.slice(offset, offset + PAGE_SIZE)
            : filtered
          setItems(
            pageItems.map((record) => ({
              clientId: activeClient.id,
              clientName: activeClient.name,
              clientKind: activeClient.kind,
              writable: activeClient.writable,
              record,
            })),
          )
          setTotal(localOwnershipFilter ? filtered.length : val.total)
          setSkippedClients([])
        })
        .catch((err) => {
          if (!cancelled) {
            if (isExternalChangeError(err)) props.onExternalChange()
            setLoadError(desktopErrorText(err))
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }

    return () => {
      cancelled = true
    }
  }, [
    bridge,
    isAllHosts,
    activeClient,
    workspaceFilter,
    typeFilter,
    statusFilter,
    ownershipFilter,
    debouncedQuery,
    offset,
    refreshToken,
    localReload,
  ])

  const pendingSelectKeyRef = React.useRef<string | undefined>(undefined)
  const itemsBeforeSaveRef = React.useRef<readonly UnifiedMemoryItem[] | undefined>(undefined)

  // Auto-select first or requested memory
  React.useEffect(() => {
    const req = props.openMemoryRequest
    if (req !== undefined && req.seq !== lastHandledOpenSeq.current) {
      lastHandledOpenSeq.current = req.seq
      pendingSelectKeyRef.current = undefined
      itemsBeforeSaveRef.current = undefined
      setSelectedKey(`${req.clientId}:${req.id}`)
      return
    }
    const pendingKey = pendingSelectKeyRef.current
    if (pendingKey !== undefined) {
      if (items === itemsBeforeSaveRef.current) {
        return
      }
      pendingSelectKeyRef.current = undefined
      itemsBeforeSaveRef.current = undefined
      if (items.some((it) => `${it.clientId}:${it.record.id}` === pendingKey)) {
        setSelectedKey(pendingKey)
        return
      }
    }
    if (items.length === 0) {
      setSelectedKey(undefined)
      setInspected(undefined)
      return
    }
    const stillExists =
      selectedKey !== undefined &&
      items.some((it) => `${it.clientId}:${it.record.id}` === selectedKey)
    if (!stillExists) {
      const first = items[0]
      if (first !== undefined) {
        setSelectedKey(`${first.clientId}:${first.record.id}`)
      }
    }
  }, [items, selectedKey, props.openMemoryRequest])

  // Load full detail & sources for selected item
  React.useEffect(() => {
    if (selectedKey === undefined) {
      setInspected(undefined)
      return undefined
    }
    const found = items.find((it) => `${it.clientId}:${it.record.id}` === selectedKey)
    if (found === undefined) return undefined
    let cancelled = false
    setInspected({
      clientId: found.clientId,
      record: found.record,
      sources: found.record.sourceRefs,
    })
    void bridge.memory
      .view({ clientId: found.clientId, id: found.record.id })
      .then((res) => {
        if (cancelled) return
        const val = unwrapIpc(res)
        setInspected({
          clientId: found.clientId,
          record: val.record,
          sources: val.sources,
        })
      })
      .catch(() => {
        // Keep list-level record snapshot when view is unavailable
      })
    return () => {
      cancelled = true
    }
  }, [bridge, selectedKey, items])

  const selectedItem =
    selectedKey !== undefined
      ? items.find((it) => `${it.clientId}:${it.record.id}` === selectedKey)
      : undefined
  const detailRecord = inspected?.record ?? selectedItem?.record
  const detailClient =
    selectedItem !== undefined ? clients.find((c) => c.id === selectedItem.clientId) : undefined

  const writableHosts = clients.filter(
    (c) =>
      c.enabled &&
      c.writable &&
      c.health !== 'corrupted' &&
      c.health !== 'unreadable' &&
      (c.health !== 'missing' || c.allowInitializeWhenMissing),
  )

  const canCreate = isAllHosts
    ? writableHosts.length > 0
    : activeClient !== undefined &&
      activeClient.enabled &&
      activeClient.writable &&
      activeClient.health !== 'corrupted' &&
      activeClient.health !== 'unreadable' &&
      (activeClient.health !== 'missing' || activeClient.allowInitializeWhenMissing)

  const handleOpenCreate = (): void => {
    if (!canCreate) {
      props.onNotify(t('desktop.guard.runningBanner'), 'warn')
      return
    }
    const defaultClient =
      !isAllHosts && activeClient !== undefined ? activeClient.id : (writableHosts[0]?.id ?? '')
    if (defaultClient === '') return
    setEditorModal({ mode: 'create', clientId: defaultClient })
  }

  const toggleCheck = (id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleTogglePin = async (clientId: string, record: MemoryRecord): Promise<void> => {
    if (busyAction) return
    setBusyAction(true)
    try {
      const updated = unwrapIpc(
        await bridge.memory.update({
          clientId,
          id: record.id,
          expectedContentRevision: record.contentRevision,
          pinned: !record.pinned,
        }),
      )
      setInspected((cur) =>
        cur !== undefined && cur.record.id === updated.id ? { ...cur, record: updated } : cur,
      )
      setLocalReload((v) => v + 1)
      await props.onDataChanged()
      props.onNotify(
        updated.pinned ? t('desktop.inspector.pinned') : t('desktop.inspector.pin'),
        'info',
      )
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    } finally {
      setBusyAction(false)
    }
  }

  const handleArchiveOrRestore = async (clientId: string, record: MemoryRecord): Promise<void> => {
    if (busyAction) return
    setBusyAction(true)
    try {
      if (record.status === 'active') {
        unwrapIpc(await bridge.memory.delete({ clientId, id: record.id }))
        props.onNotify(t('delete.archived'), 'success')
      } else {
        unwrapIpc(await bridge.memory.restore({ clientId, id: record.id }))
        props.onNotify(t('common.restore'), 'success')
      }
      setLocalReload((v) => v + 1)
      await props.onDataChanged()
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    } finally {
      setBusyAction(false)
    }
  }

  const handlePermanentDelete = async (): Promise<void> => {
    if (confirmPermanent === undefined || busyAction) return
    setBusyAction(true)
    try {
      unwrapIpc(
        await bridge.memory.delete({
          clientId: confirmPermanent.clientId,
          id: confirmPermanent.record.id,
          permanent: true,
          confirm: true,
          actor: 'user',
        }),
      )
      setConfirmPermanent(undefined)
      setSelectedKey(undefined)
      setLocalReload((v) => v + 1)
      await props.onDataChanged()
      props.onNotify(t('desktop.detail.permanentDelete'), 'info')
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    } finally {
      setBusyAction(false)
    }
  }

  const handleBatchArchive = async (): Promise<void> => {
    if (activeClient === undefined || checkedIds.size === 0 || busyAction) return
    if (!activeClient.writable) {
      props.onNotify(t('desktop.error.readonlyGuard'), 'warn')
      return
    }
    setBusyAction(true)
    let count = 0
    try {
      for (const id of checkedIds) {
        unwrapIpc(await bridge.memory.delete({ clientId: activeClient.id, id }))
        count += 1
      }
      setCheckedIds(new Set())
      setLocalReload((v) => v + 1)
      await props.onDataChanged()
      props.onNotify(`${t('delete.archived')} (${count})`, 'success')
    } catch (err) {
      if (count > 0) {
        setCheckedIds(new Set())
        setLocalReload((v) => v + 1)
        void props.onDataChanged().catch(() => undefined)
      }
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    } finally {
      setBusyAction(false)
    }
  }

  const hostOptions = [
    { value: 'all', label: t('desktop.allHosts') },
    ...clients.map((c) => ({ value: c.id, label: c.name })),
  ]
  const workspaceOptions = [
    { value: 'all', label: t('desktop.filter.allWorkspaces') },
    ...workspaces.map((w) => ({
      value: w.key,
      label: w.key === 'global' ? t('scope.global') : w.root,
    })),
  ]
  const statusOptions = [
    { value: 'all', label: t('status.all') },
    { value: 'active', label: t('status.active') },
    { value: 'archived', label: t('status.archived') },
  ]
  const ownerOptions = [
    { value: 'all', label: t('desktop.filter.ownerAll') },
    { value: 'user', label: t('desktop.filter.ownerUser') },
    { value: 'derived', label: t('desktop.filter.ownerDerived') },
  ]

  const renderSingleStoreBlockedOrMissing = (): React.ReactElement | null => {
    if (activeClient === undefined) return null
    if (!activeClient.enabled) {
      return h(EmptyBlock, {
        icon: Icons.lock(),
        title: t('desktop.client.disabledTitle'),
        description: t('desktop.client.disabledDesc'),
      })
    }
    if (activeClient.health === 'corrupted' || activeClient.health === 'unreadable') {
      return h(EmptyBlock, {
        icon: Icons.shield(),
        title: t('desktop.client.corruptTitle'),
        description: activeClient.healthDetail ?? activeClient.storePath,
      })
    }
    if (activeClient.health === 'missing') {
      return h(EmptyBlock, {
        icon: Icons.layers(),
        title:
          activeClient.kind === 'dsh'
            ? t('desktop.client.missingDshTitle')
            : t('desktop.client.missingInitTitle'),
        description:
          activeClient.kind === 'dsh'
            ? t('desktop.client.missingDshDesc')
            : t('desktop.client.missingInitDesc'),
        action:
          activeClient.allowInitializeWhenMissing && activeClient.writable
            ? h(
                'div',
                { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                h(Button, { variant: 'primary', onClick: handleOpenCreate }, t('common.new')),
                h(
                  Button,
                  {
                    variant: 'surface',
                    onClick: () => props.onOpenMigration(activeClient.id),
                  },
                  t('desktop.migrateQuick'),
                ),
              )
            : undefined,
      })
    }
    return null
  }

  const blockedView = !isAllHosts ? renderSingleStoreBlockedOrMissing() : null

  return h(
    React.Fragment,
    null,
    // Top Header Toolbar
    h(
      'header',
      { className: 'ml-stage-header' },
      h(
        'div',
        { className: 'ml-search-box' },
        h(
          'span',
          { style: { color: 'var(--ml-text-muted)', display: 'inline-flex' } },
          Icons.search(),
        ),
        h('input', {
          type: 'text',
          className: 'ml-search-input',
          'aria-label': t('filter.search'),
          placeholder: t('filter.searchPlaceholder'),
          value: searchInput,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSearchInput(e.target.value),
        }),
        searchInput !== ''
          ? h(
              'button',
              {
                type: 'button',
                className: 'ml-search-clear',
                'aria-label': t('common.clear'),
                onClick: () => {
                  setSearchInput('')
                  setDebouncedQuery('')
                },
              },
              Icons.close(),
            )
          : null,
      ),
      h(
        'div',
        { className: 'ml-toolbar-actions' },
        h(Dropdown, {
          label: t('desktop.filter.hostPrefix'),
          prefix: t('desktop.filter.hostPrefix'),
          value: activeHostId,
          options: hostOptions,
          onChange: (val) => props.onSelectHost(val),
        }),
        h(Dropdown, {
          label: t('desktop.filter.workspacePrefix'),
          prefix: t('desktop.filter.workspacePrefix'),
          value: workspaceFilter,
          options: workspaceOptions,
          onChange: setWorkspaceFilter,
        }),
        h(
          Button,
          {
            variant: 'primary',
            disabled: !canCreate,
            onClick: handleOpenCreate,
          },
          Icons.plus(),
          h('span', null, t('common.new')),
        ),
      ),
    ),

    props.banners ?? null,

    skippedClients.length > 0
      ? h(
          'div',
          { className: 'ml-banner', 'data-tone': 'warn', role: 'status' },
          h(
            'div',
            { className: 'ml-banner-main' },
            Icons.shield(),
            h(
              'span',
              null,
              formatMessage('desktop.aggregate.skippedWarning', {
                details: skippedClients.map((s) => `${s.name} (${s.health})`).join('；'),
              }),
            ),
          ),
        )
      : null,

    // Secondary Segmented Filter Bar
    h(
      'div',
      { className: 'ml-filter-strip' },
      h(SegmentedControl<MemoryType | 'all'>, {
        label: t('desktop.aggregate.typeCategories'),
        role: 'tablist',
        value: typeFilter,
        onChange: setTypeFilter,
        items: [
          { id: 'all', label: t('type.all') },
          { id: 'lesson', label: t('type.lesson') },
          { id: 'wiki', label: t('type.wiki') },
          { id: 'worklog', label: t('type.worklog') },
          { id: 'preference', label: t('type.preference') },
        ],
      }),
      h(
        'div',
        { className: 'ml-toolbar-actions' },
        h(Dropdown, {
          label: t('desktop.filter.statusPrefix'),
          prefix: t('desktop.filter.statusPrefix'),
          value: statusFilter,
          options: statusOptions,
          onChange: (v) => setStatusFilter(v as MemoryStatus | 'all'),
        }),
        !isAllHosts
          ? h(Dropdown, {
              label: t('desktop.inspector.ownership'),
              value: ownershipFilter,
              options: ownerOptions,
              onChange: (v) => setOwnershipFilter(v as MemoryOwnership | 'all'),
            })
          : null,
      ),
    ),

    // Master-Detail Body
    blockedView !== null
      ? blockedView
      : h(
          'div',
          { className: 'ml-split' },
          // Left List
          h(
            'div',
            {
              className: `ml-list-pane ml-scroll ${checkedIds.size > 0 ? 'ml-has-selection' : ''}`,
              role: 'list',
              'aria-label': t('list.title'),
            },
            loading
              ? h(EmptyBlock, { title: t('state.loading') })
              : loadError !== ''
                ? h(EmptyBlock, {
                    icon: Icons.shield(),
                    title: t('state.error'),
                    description: loadError,
                    action: h(
                      Button,
                      { variant: 'surface', onClick: () => setLocalReload((v) => v + 1) },
                      t('common.retry'),
                    ),
                  })
                : items.length === 0
                  ? h(EmptyBlock, {
                      icon: Icons.layers(),
                      title: t('list.empty'),
                      ...(debouncedQuery !== '' ? { description: t('list.noMatches') } : {}),
                    })
                  : h(
                      React.Fragment,
                      null,
                      items.map((item) => {
                        const rowKey = `${item.clientId}:${item.record.id}`
                        const isSelected = rowKey === selectedKey
                        const isChecked = checkedIds.has(item.record.id)
                        const hostPalette = hostColorVars(item.clientKind)
                        const hostShort =
                          clients.find((c) => c.id === item.clientId) !== undefined
                            ? formatHostCompact(clients.find((c) => c.id === item.clientId)!)
                            : item.clientName
                        const scopeLabel =
                          item.record.scope.kind === 'global'
                            ? t('scope.global')
                            : item.record.scope.root
                        return h(
                          'div',
                          {
                            key: rowKey,
                            role: 'listitem',
                            className: 'ml-mem-row',
                            'data-selected': isSelected,
                            'data-checked': isChecked,
                            onClick: () => setSelectedKey(rowKey),
                          },
                          h(
                            'div',
                            { className: 'ml-row-lead' },
                            h(
                              'span',
                              {
                                className: 'ml-row-type-icon',
                                style: { color: typeColorVar(item.record.type) },
                              },
                              Icons.memoryType(item.record.type),
                            ),
                            !isAllHosts
                              ? h(
                                  'span',
                                  { className: 'ml-row-check-wrap' },
                                  h(Checkbox, {
                                    checked: isChecked,
                                    label: item.record.title,
                                    onChange: () => toggleCheck(item.record.id),
                                  }),
                                )
                              : h(
                                  'span',
                                  {
                                    className: 'ml-row-check-wrap',
                                    style: { color: typeColorVar(item.record.type) },
                                  },
                                  Icons.memoryType(item.record.type),
                                ),
                          ),
                          h(
                            'div',
                            { className: 'ml-row-body' },
                            h(
                              'div',
                              { className: 'ml-row-top' },
                              h(
                                'div',
                                { className: 'ml-row-title-wrap' },
                                h('span', { className: 'ml-row-title' }, item.record.title),
                                item.record.status !== 'active'
                                  ? h(
                                      'span',
                                      {
                                        className: 'ml-row-status-pill',
                                        'data-status': item.record.status,
                                      },
                                      t(`status.${item.record.status}`),
                                    )
                                  : null,
                                item.record.pinned
                                  ? h(
                                      'span',
                                      {
                                        style: {
                                          color: 'var(--ml-copper)',
                                          display: 'inline-flex',
                                        },
                                      },
                                      Icons.pin(),
                                    )
                                  : null,
                              ),
                              h(
                                'span',
                                {
                                  className: 'ml-tabular',
                                  style: {
                                    fontSize: '12px',
                                    color: 'var(--ml-text-muted)',
                                    flex: 'none',
                                  },
                                },
                                formatStamp(item.record.updatedAt).slice(5),
                              ),
                            ),
                            h(
                              'p',
                              { className: 'ml-row-excerpt' },
                              item.record.body.replace(/[`\n]+/g, ' '),
                            ),
                            h(
                              'div',
                              { className: 'ml-row-meta' },
                              h(
                                'div',
                                { className: 'ml-row-meta-left' },
                                h(
                                  'span',
                                  {
                                    style: {
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '5px',
                                      color: hostPalette.color,
                                      fontWeight: 500,
                                    },
                                  },
                                  h(HostLogo, { kind: item.clientKind, size: 12 }),
                                  hostShort,
                                ),
                                h(
                                  'span',
                                  { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
                                  scopeLabel,
                                ),
                                h(
                                  'span',
                                  null,
                                  item.record.ownership === 'user'
                                    ? t('desktop.filter.ownerUser')
                                    : t('desktop.filter.ownerDerived'),
                                ),
                              ),
                              h(
                                'span',
                                { className: 'ml-tabular', style: { flex: 'none' } },
                                formatMessage('desktop.inspector.statsVal', {
                                  match: item.record.matchCount,
                                  use: item.record.useCount,
                                }),
                              ),
                            ),
                          ),
                        )
                      }),
                      total > PAGE_SIZE
                        ? h(
                            'div',
                            {
                              style: {
                                padding: '10px 14px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                fontSize: '12px',
                                color: 'var(--ml-text-muted)',
                              },
                            },
                            h(
                              'span',
                              { className: 'ml-tabular' },
                              formatMessage('list.total', { total }),
                            ),
                            h(
                              'div',
                              { style: { display: 'flex', gap: '6px' } },
                              h(
                                Button,
                                {
                                  size: 'sm',
                                  disabled: offset === 0,
                                  onClick: () => setOffset((o) => Math.max(0, o - PAGE_SIZE)),
                                },
                                t('list.pagePrev'),
                              ),
                              h(
                                Button,
                                {
                                  size: 'sm',
                                  disabled: offset + PAGE_SIZE >= total,
                                  onClick: () => setOffset((o) => o + PAGE_SIZE),
                                },
                                t('list.pageNext'),
                              ),
                            ),
                          )
                        : null,
                    ),
          ),

          // Right Inspector
          h(
            'aside',
            { className: 'ml-inspector', 'aria-label': t('list.title') },
            detailRecord === undefined || selectedItem === undefined
              ? h(EmptyBlock, { title: t('desktop.inspector.selectHint') })
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'ml-inspector-scroll ml-scroll' },
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
                      h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                          },
                        },
                        h(
                          'div',
                          {
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              flexWrap: 'wrap',
                            },
                          },
                          h(HostTag, {
                            kind: selectedItem.clientKind,
                            label: selectedItem.clientName,
                          }),
                          h(TypeTag, {
                            type: detailRecord.type,
                            label: t(`type.${detailRecord.type}`),
                          }),
                        ),
                        h(
                          Button,
                          {
                            size: 'sm',
                            disabled: !selectedItem.writable || busyAction,
                            onClick: () =>
                              void handleTogglePin(selectedItem.clientId, detailRecord),
                          },
                          Icons.pin(),
                          h(
                            'span',
                            null,
                            detailRecord.pinned
                              ? t('desktop.inspector.pinned')
                              : t('desktop.inspector.pin'),
                          ),
                        ),
                      ),
                      h(
                        'h2',
                        {
                          style: { margin: 0, fontSize: '16px', fontWeight: 600, lineHeight: 1.4 },
                        },
                        detailRecord.title,
                      ),
                    ),

                    h(
                      'div',
                      { className: 'ml-surface-card', style: { padding: '16px' } },
                      h(MarkdownProse, { text: detailRecord.body }),
                    ),

                    h(
                      'div',
                      { className: 'ml-prop-table' },
                      h(
                        'div',
                        { className: 'ml-prop-row' },
                        h('span', { className: 'ml-prop-key' }, t('desktop.inspector.scope')),
                        h(
                          'span',
                          { className: 'ml-prop-val ml-mono' },
                          detailRecord.scope.kind === 'global'
                            ? t('scope.global')
                            : detailRecord.scope.root,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ml-prop-row' },
                        h('span', { className: 'ml-prop-key' }, t('desktop.inspector.ownership')),
                        h(
                          'span',
                          { className: 'ml-prop-val' },
                          detailRecord.ownership === 'user'
                            ? t('desktop.inspector.ownerUserDesc')
                            : t('desktop.inspector.ownerDerivedDesc'),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ml-prop-row' },
                        h(
                          'span',
                          { className: 'ml-prop-key' },
                          t('desktop.inspector.revisionConf'),
                        ),
                        h(
                          'span',
                          { className: 'ml-prop-val ml-tabular' },
                          `rev ${detailRecord.contentRevision} · ${Math.round(detailRecord.confidence * 100)}%`,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ml-prop-row' },
                        h('span', { className: 'ml-prop-key' }, t('desktop.inspector.stats')),
                        h(
                          'span',
                          { className: 'ml-prop-val ml-tabular' },
                          formatMessage('desktop.inspector.statsVal', {
                            match: detailRecord.matchCount,
                            use: detailRecord.useCount,
                          }),
                        ),
                      ),
                      detailRecord.tags.length > 0
                        ? h(
                            'div',
                            { className: 'ml-prop-row' },
                            h('span', { className: 'ml-prop-key' }, t('desktop.inspector.tags')),
                            h(
                              'span',
                              { className: 'ml-prop-val ml-mono' },
                              detailRecord.tags.map((tg) => `#${tg}`).join('  '),
                            ),
                          )
                        : null,
                    ),

                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                      h(
                        'div',
                        {
                          style: {
                            fontSize: '12px',
                            fontWeight: 500,
                            color: 'var(--ml-text-muted)',
                          },
                        },
                        t('desktop.inspector.sources'),
                      ),
                      (inspected?.sources ?? detailRecord.sourceRefs).length === 0
                        ? h(
                            'div',
                            {
                              className: 'ml-surface-card',
                              style: {
                                padding: '14px',
                                fontSize: '12px',
                                color: 'var(--ml-text-muted)',
                              },
                            },
                            t('desktop.inspector.noSources'),
                          )
                        : (inspected?.sources ?? detailRecord.sourceRefs).map((ref, idx) =>
                            h(
                              'div',
                              {
                                key: `${ref.sessionId}:${idx}`,
                                className: 'ml-surface-card',
                                style: {
                                  padding: '12px 14px',
                                  fontSize: '12px',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '6px',
                                },
                              },
                              h(
                                'div',
                                {
                                  style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    color: 'var(--ml-text-muted)',
                                  },
                                },
                                h('span', { className: 'ml-mono' }, ref.sessionId),
                                h('span', { className: 'ml-tabular' }, `Turn ${ref.turn ?? 0}`),
                              ),
                              ref.quote !== undefined && ref.quote !== ''
                                ? h('div', { style: { lineHeight: 1.55 } }, ref.quote)
                                : null,
                            ),
                          ),
                    ),
                  ),

                  h(
                    'div',
                    { className: 'ml-inspector-footer' },
                    !selectedItem.writable
                      ? h(
                          'span',
                          {
                            style: {
                              fontSize: '12px',
                              color: 'var(--ml-warn)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                            },
                          },
                          Icons.lock(),
                          h('span', null, t('desktop.status.readonly')),
                        )
                      : h('span'),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      isAllHosts
                        ? h(
                            Button,
                            {
                              size: 'sm',
                              onClick: () =>
                                props.onSelectHost(selectedItem.clientId, detailRecord.id),
                            },
                            t('desktop.aggregate.openInClient'),
                          )
                        : null,
                      h(
                        Button,
                        {
                          size: 'sm',
                          onClick: () =>
                            props.onOpenMigration(selectedItem.clientId, {
                              kind: 'records',
                              memoryIds: [detailRecord.id],
                            }),
                        },
                        Icons.migrate(),
                        h('span', null, t('desktop.inspector.migrate')),
                      ),
                      !isAllHosts
                        ? h(
                            React.Fragment,
                            null,
                            h(
                              Button,
                              {
                                size: 'sm',
                                disabled: !selectedItem.writable || detailClient === undefined,
                                onClick: () =>
                                  setEditorModal({
                                    mode: 'edit',
                                    clientId: selectedItem.clientId,
                                    record: detailRecord,
                                  }),
                              },
                              Icons.edit(),
                              h('span', null, t('common.edit')),
                            ),
                            h(
                              Button,
                              {
                                size: 'sm',
                                disabled: !selectedItem.writable || busyAction,
                                onClick: () =>
                                  void handleArchiveOrRestore(selectedItem.clientId, detailRecord),
                              },
                              detailRecord.status === 'active' ? Icons.archive() : Icons.restore(),
                              h(
                                'span',
                                null,
                                detailRecord.status === 'active'
                                  ? t('desktop.inspector.softForget')
                                  : t('common.restore'),
                              ),
                            ),
                            detailRecord.status === 'archived'
                              ? h(
                                  Button,
                                  {
                                    size: 'sm',
                                    variant: 'danger',
                                    disabled: !selectedItem.writable || busyAction,
                                    onClick: () =>
                                      setConfirmPermanent({
                                        clientId: selectedItem.clientId,
                                        record: detailRecord,
                                      }),
                                  },
                                  t('desktop.detail.permanentDelete'),
                                )
                              : null,
                          )
                        : null,
                    ),
                  ),
                ),
          ),
        ),

    // Floating Batch Bar
    !isAllHosts && checkedIds.size > 0 && activeClient !== undefined
      ? h(
          'div',
          { className: 'ml-floating-bar' },
          h(
            'span',
            { className: 'ml-tabular', style: { fontSize: '12px', fontWeight: 500 } },
            formatMessage('desktop.inspector.selectedBatch', { count: checkedIds.size }),
          ),
          h('div', {
            style: { width: '1px', height: '16px', background: 'var(--ml-border-strong)' },
          }),
          h(
            Button,
            {
              size: 'sm',
              variant: 'primary',
              onClick: () => {
                const ids = [...checkedIds]
                setCheckedIds(new Set())
                props.onOpenMigration(activeClient.id, { kind: 'records', memoryIds: ids })
              },
            },
            Icons.migrate(),
            h('span', null, t('desktop.inspector.batchMigrate')),
          ),
          h(
            Button,
            {
              size: 'sm',
              disabled: !activeClient.writable || busyAction,
              onClick: () => void handleBatchArchive(),
            },
            t('desktop.inspector.batchForget'),
          ),
          h(
            Button,
            { size: 'sm', variant: 'ghost', onClick: () => setCheckedIds(new Set()) },
            t('common.cancel'),
          ),
        )
      : null,

    // Create / Edit Modal
    editorModal !== undefined
      ? h(MemoryEditorModal, {
          bridge,
          mode: editorModal.mode,
          initialClientId: editorModal.clientId,
          writableHosts:
            editorModal.mode === 'create'
              ? writableHosts
              : clients.filter((c) => c.id === editorModal.clientId),
          workspaces,
          ...(editorModal.record !== undefined ? { record: editorModal.record } : {}),
          onClose: () => setEditorModal(undefined),
          onExternalChange: props.onExternalChange,
          onSaved: async (savedRecord) => {
            const targetKey = `${editorModal.clientId}:${savedRecord.id}`
            const savedMode = editorModal.mode
            pendingSelectKeyRef.current = targetKey
            itemsBeforeSaveRef.current = items
            setEditorModal(undefined)
            setLocalReload((v) => v + 1)
            await props.onDataChanged()
            setSelectedKey(targetKey)
            props.onNotify(
              savedMode === 'create' ? t('create.created') : t('detail.updated'),
              'success',
            )
          },
        })
      : null,

    // Permanent Delete Confirm Modal
    confirmPermanent !== undefined
      ? h(
          Modal,
          {
            title: t('desktop.detail.permanentDelete'),
            closeLabel: t('common.close'),
            maxWidth: 440,
            onClose: () => setConfirmPermanent(undefined),
            footer: h(
              React.Fragment,
              null,
              h(Button, { onClick: () => setConfirmPermanent(undefined) }, t('common.cancel')),
              h(
                Button,
                {
                  variant: 'danger',
                  disabled: busyAction,
                  onClick: () => void handlePermanentDelete(),
                },
                t('desktop.detail.permanentDelete'),
              ),
            ),
          },
          h(
            'p',
            {
              style: {
                margin: 0,
                fontSize: '13px',
                color: 'var(--ml-text-secondary)',
                lineHeight: 1.6,
              },
            },
            t('desktop.detail.permanentDeleteConfirm'),
          ),
        )
      : null,
  )
}

/* ------------------------------------------------------------------ *
 * Custom Create / Edit Memory Modal (Preserves Draft on External Change)
 * ------------------------------------------------------------------ */

function MemoryEditorModal(props: {
  readonly bridge: DesktopBridgeApi
  readonly mode: 'create' | 'edit'
  readonly initialClientId: string
  readonly writableHosts: readonly DesktopClientInfo[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly record?: MemoryRecord
  readonly onClose: () => void
  readonly onExternalChange: () => void
  readonly onSaved: (record: MemoryRecord) => Promise<void>
}): React.ReactElement {
  const [clientId, setClientId] = React.useState(props.initialClientId)
  const [type, setType] = React.useState<MemoryType>(props.record?.type ?? 'lesson')
  const [scopeKind, setScopeKind] = React.useState<'workspace' | 'global'>(
    props.record?.scope.kind ?? 'workspace',
  )
  const [workspaceRoot, setWorkspaceRoot] = React.useState<string>(() => {
    if (props.record?.scope.kind === 'workspace') return props.record.scope.root
    return props.workspaces.find((w) => w.key !== 'global')?.root ?? ''
  })
  const [title, setTitle] = React.useState(props.record?.title ?? '')
  const [body, setBody] = React.useState(props.record?.body ?? '')
  const [tagsText, setTagsText] = React.useState(props.record?.tags.join(', ') ?? '')
  const [pinned, setPinned] = React.useState(props.record?.pinned ?? false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  const dirty =
    props.mode === 'create'
      ? title.trim() !== '' || body.trim() !== ''
      : title !== (props.record?.title ?? '') ||
        body !== (props.record?.body ?? '') ||
        tagsText !== (props.record?.tags.join(', ') ?? '') ||
        pinned !== (props.record?.pinned ?? false) ||
        type !== (props.record?.type ?? 'lesson')

  const attemptClose = (): void => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    props.onClose()
  }

  const pickDir = async (): Promise<void> => {
    setError('')
    try {
      const picked = unwrapIpc(await props.bridge.dialog.pickDirectory())
      if (picked !== null && picked !== '') {
        setScopeKind('workspace')
        setWorkspaceRoot(picked)
      }
    } catch (err) {
      setError(desktopErrorText(err))
    }
  }

  const handleSave = async (): Promise<void> => {
    if (title.trim() === '') {
      setError(t('error.invalid'))
      return
    }
    const tags = tagsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    setSaving(true)
    setError('')
    try {
      if (props.mode === 'create') {
        const wsRootTrimmed = workspaceRoot.trim()
        const created = unwrapIpc(
          await props.bridge.memory.create({
            clientId,
            type,
            title: title.trim(),
            body,
            scope: scopeKind,
            tags,
            pinned,
            ...(scopeKind === 'workspace' && wsRootTrimmed !== ''
              ? {
                  workspaceKey: normalizeWorkspaceKey(wsRootTrimmed),
                  workspaceRoot: wsRootTrimmed,
                }
              : {}),
          }),
        )
        await props.onSaved(created)
      } else if (props.record !== undefined) {
        const updated = unwrapIpc(
          await props.bridge.memory.update({
            clientId,
            id: props.record.id,
            expectedContentRevision: props.record.contentRevision,
            type,
            title: title.trim(),
            body,
            tags,
            pinned,
          }),
        )
        await props.onSaved(updated)
      }
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      setError(desktopErrorText(err))
    } finally {
      setSaving(false)
    }
  }

  const hostOptions = props.writableHosts.map((c) => ({ value: c.id, label: c.name }))
  const scopeOptions = [
    { value: 'workspace', label: t('scope.workspace') },
    { value: 'global', label: t('scope.global') },
  ]

  return h(
    Modal,
    {
      title: props.mode === 'create' ? t('create.title') : t('common.edit'),
      closeLabel: t('common.close'),
      onClose: attemptClose,
      footer: confirmDiscard
        ? h(
            React.Fragment,
            null,
            h(
              'span',
              { style: { fontSize: '12px', color: 'var(--ml-warn)', marginRight: 'auto' } },
              t('detail.dirtyClose'),
            ),
            h(Button, { onClick: () => setConfirmDiscard(false) }, t('detail.keepEditing')),
            h(Button, { variant: 'danger', onClick: props.onClose }, t('detail.discardChanges')),
          )
        : h(
            React.Fragment,
            null,
            h(Button, { disabled: saving, onClick: attemptClose }, t('common.cancel')),
            h(
              Button,
              { variant: 'primary', disabled: saving, onClick: () => void handleSave() },
              saving ? t('common.saving') : t('common.save'),
            ),
          ),
    },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      error !== ''
        ? h(
            'div',
            {
              className: 'ml-banner',
              'data-tone': 'danger',
              role: 'alert',
              style: { borderRadius: '8px', border: '1px solid var(--ml-danger-border)' },
            },
            error,
          )
        : null,
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        h(
          'div',
          { className: 'ml-field' },
          h('span', { className: 'ml-field-label' }, t('desktop.filter.hostPrefix')),
          h(Dropdown, {
            label: t('desktop.filter.hostPrefix'),
            value: clientId,
            options: hostOptions,
            disabled: props.mode === 'edit' || hostOptions.length <= 1,
            fullWidth: true,
            onChange: setClientId,
          }),
        ),
        h(
          'div',
          { className: 'ml-field' },
          h('span', { className: 'ml-field-label' }, t('create.scope')),
          h(Dropdown, {
            label: t('create.scope'),
            value: scopeKind,
            options: scopeOptions,
            disabled: props.mode === 'edit',
            fullWidth: true,
            onChange: (val) => {
              const next = val === 'global' ? 'global' : 'workspace'
              setScopeKind(next)
              if (next === 'global') setType('preference')
            },
          }),
        ),
      ),

      scopeKind === 'workspace' && props.mode === 'create'
        ? h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-end', gap: '8px' } },
            h(
              'div',
              { style: { flex: '1 1 auto' } },
              h(TextField, {
                label: t('filter.workspace'),
                value: workspaceRoot,
                placeholder: 'C:/Projects/memloom',
                onChange: setWorkspaceRoot,
              }),
            ),
            h(Button, { onClick: () => void pickDir() }, t('desktop.create.pickWorkspace')),
          )
        : null,

      h(
        'div',
        { className: 'ml-field' },
        h('span', { className: 'ml-field-label' }, t('create.type')),
        h(SegmentedControl<MemoryType>, {
          label: t('create.type'),
          fullWidth: true,
          value: type,
          onChange: (val) => {
            setType(val)
            if (val !== 'preference' && scopeKind === 'global') {
              setScopeKind('workspace')
            }
          },
          items: [
            { id: 'lesson', label: t('type.lesson') },
            { id: 'wiki', label: t('type.wiki') },
            { id: 'worklog', label: t('type.worklog') },
            { id: 'preference', label: t('type.preference') },
          ],
        }),
      ),

      h(TextField, {
        label: t('detail.title'),
        value: title,
        placeholder: t('create.titleField'),
        onChange: setTitle,
      }),

      h(TextField, {
        label: t('detail.body'),
        value: body,
        multiline: true,
        rows: 5,
        placeholder: t('create.bodyField'),
        onChange: setBody,
      }),

      h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: '12px',
            alignItems: 'end',
          },
        },
        h(TextField, {
          label: t('detail.tags'),
          value: tagsText,
          placeholder: t('detail.tagsPlaceholder'),
          onChange: setTagsText,
        }),
        h(Switch, {
          label: t('detail.pinned'),
          checked: pinned,
          onChange: setPinned,
        }),
      ),
    ),
  )
}
