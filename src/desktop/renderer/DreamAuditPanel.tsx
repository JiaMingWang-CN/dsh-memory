/**
 * Dreams & Audit workbench view displaying historical DreamRun batches
 * (with confirmed batch undoDream) and immutable audit timeline with diff expansion.
 * @module memloom/desktop/renderer/DreamAuditPanel
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import type { AuditAction, AuditRecord, DreamRun } from '../../shared/types.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type { DesktopClientInfo } from '../multi-service.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'
import {
  Button,
  Dropdown,
  EmptyBlock,
  HostLogo,
  HostTag,
  Icons,
  Modal,
  SegmentedControl,
} from './ui.tsx'

const h = React.createElement

export interface DreamAuditPanelProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly refreshToken: number
  readonly banners?: React.ReactNode
  readonly onDataChanged: () => Promise<void>
  readonly onExternalChange: () => void
  readonly onNotify: (message: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void
}

const AUDIT_ACTIONS: readonly AuditAction[] = [
  'create',
  'update',
  'archive',
  'restore',
  'delete',
  'accept',
  'reject',
  'dream-commit',
  'dream-undo',
  'rebuild',
  'import',
  'purge',
]

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function DreamAuditPanel(props: DreamAuditPanelProps): React.ReactElement {
  const { bridge, clients, refreshToken } = props
  const healthyClients = React.useMemo(
    () => clients.filter((c) => c.enabled && c.health === 'ready'),
    [clients],
  )

  const [subTab, setSubTab] = React.useState<'dreams' | 'timeline'>('dreams')
  const [hostId, setHostId] = React.useState<string>(
    () => healthyClients[0]?.id ?? clients[0]?.id ?? '',
  )
  const [actionFilter, setActionFilter] = React.useState<string>('all')
  const [memoryIdFilter, setMemoryIdFilter] = React.useState('')
  const [dreamIdFilter, setDreamIdFilter] = React.useState('')

  const [dreams, setDreams] = React.useState<DreamRun[]>([])
  const [audits, setAudits] = React.useState<AuditRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [expandedAuditIds, setExpandedAuditIds] = React.useState<Record<string, boolean>>({})
  const [confirmUndo, setConfirmUndo] = React.useState<DreamRun | undefined>(undefined)
  const [undoBusy, setUndoBusy] = React.useState(false)
  const [localReload, setLocalReload] = React.useState(0)

  React.useEffect(() => {
    if (hostId === '' || !clients.some((c) => c.id === hostId)) {
      const next = healthyClients[0]?.id ?? clients[0]?.id ?? ''
      if (next !== '') setHostId(next)
    }
  }, [hostId, clients, healthyClients])

  const activeClient = clients.find((c) => c.id === hostId)
  const onExternalChangeRef = React.useRef(props.onExternalChange)
  onExternalChangeRef.current = props.onExternalChange

  React.useEffect(() => {
    if (activeClient === undefined || !activeClient.enabled || activeClient.health !== 'ready') {
      setDreams([])
      setAudits([])
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setError('')
    const memId = memoryIdFilter.trim()
    const drmId = dreamIdFilter.trim()
    Promise.all([
      bridge.memory.listDreams({ clientId: activeClient.id, limit: 50 }),
      bridge.memory.listAudit({
        clientId: activeClient.id,
        ...(memId !== '' ? { memoryId: memId } : {}),
        ...(drmId !== '' ? { dreamId: drmId } : {}),
        limit: 200,
      }),
    ])
      .then(([dreamsRes, auditRes]) => {
        if (cancelled) return
        setDreams(unwrapIpc(dreamsRes))
        setAudits(unwrapIpc(auditRes).items)
      })
      .catch((err) => {
        if (!cancelled) {
          if (isExternalChangeError(err)) onExternalChangeRef.current()
          setError(desktopErrorText(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bridge, activeClient, memoryIdFilter, dreamIdFilter, refreshToken, localReload])

  const executeUndo = async (): Promise<void> => {
    if (confirmUndo === undefined || activeClient === undefined || undoBusy) return
    setUndoBusy(true)
    try {
      const report = unwrapIpc(
        await bridge.memory.undoDream({ clientId: activeClient.id, dreamId: confirmUndo.id }),
      )
      setConfirmUndo(undefined)
      setLocalReload((v) => v + 1)
      await props.onDataChanged()
      props.onNotify(
        formatMessage('dream.undoResult', { undone: report.undone, skipped: report.skipped }),
        'success',
      )
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    } finally {
      setUndoBusy(false)
    }
  }

  const filteredAudits =
    actionFilter === 'all' ? audits : audits.filter((a) => a.action === actionFilter)

  const hostOptions = clients.map((c) => ({
    value: c.id,
    label: c.name,
    icon: h(HostLogo, { kind: c.kind, size: 14 }),
  }))
  const actionOptions = [
    { value: 'all', label: t('desktop.audit.allActions') },
    ...AUDIT_ACTIONS.map((a) => ({ value: a, label: a })),
  ]

  return h(
    React.Fragment,
    null,
    h(
      'header',
      { className: 'ml-stage-header' },
      h(
        'div',
        { className: 'ml-stage-title-group' },
        h('h1', { className: 'ml-stage-title' }, t('desktop.nav.audit')),
        h(SegmentedControl<'dreams' | 'timeline'>, {
          label: t('desktop.nav.audit'),
          role: 'tablist',
          value: subTab,
          onChange: setSubTab,
          items: [
            { id: 'dreams', label: t('desktop.dream.historyTitle') },
            { id: 'timeline', label: t('desktop.audit.title') },
          ],
        }),
      ),
      h(
        'div',
        { className: 'ml-toolbar-actions' },
        hostOptions.length > 0
          ? h(Dropdown, {
              label: t('desktop.filter.hostPrefix'),
              prefix: t('desktop.filter.hostPrefix'),
              value: hostId,
              options: hostOptions,
              onChange: setHostId,
            })
          : null,
        subTab === 'timeline'
          ? h(Dropdown, {
              label: t('desktop.audit.filterAction'),
              prefix: t('desktop.audit.filterAction'),
              value: actionFilter,
              options: actionOptions,
              onChange: setActionFilter,
            })
          : null,
      ),
    ),

    props.banners ?? null,

    h(
      'div',
      { className: 'ml-scroll-canvas ml-scroll' },
      loading
        ? h(EmptyBlock, { title: t('state.loading') })
        : error !== ''
          ? h(EmptyBlock, {
              icon: Icons.shield(),
              title: t('state.error'),
              description: error,
              action: h(Button, { onClick: () => setLocalReload((v) => v + 1) }, t('common.retry')),
            })
          : subTab === 'dreams'
            ? dreams.length === 0
              ? h(EmptyBlock, {
                  icon: Icons.history(),
                  title: t('desktop.dream.empty'),
                  description: t('desktop.dream.hostHint'),
                })
              : h(
                  'div',
                  { className: 'ml-table-card' },
                  h(
                    'table',
                    { className: 'ml-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, 'Dream ID'),
                        h('th', null, t('desktop.dream.trigger')),
                        h('th', null, t('dream.model')),
                        h('th', { style: { textAlign: 'right' } }, t('dream.episodes')),
                        h('th', { style: { textAlign: 'right' } }, t('dream.committed')),
                        h('th', null, t('filter.status')),
                        h('th', { style: { textAlign: 'right' } }, ''),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      dreams.map((run) => {
                        const statusColor =
                          run.status === 'completed'
                            ? 'var(--ml-success)'
                            : run.status === 'failed'
                              ? 'var(--ml-danger)'
                              : 'var(--ml-text-muted)'
                        return h(
                          'tr',
                          { key: run.id },
                          h(
                            'td',
                            null,
                            h('div', { className: 'ml-mono', style: { fontWeight: 500 } }, run.id),
                            h(
                              'div',
                              {
                                className: 'ml-tabular',
                                style: { color: 'var(--ml-text-muted)', marginTop: '2px' },
                              },
                              formatTime(run.startedAt),
                            ),
                          ),
                          h('td', null, run.trigger),
                          h(
                            'td',
                            { className: 'ml-mono', style: { color: 'var(--ml-text-secondary)' } },
                            run.model || '—',
                          ),
                          h(
                            'td',
                            { className: 'ml-tabular', style: { textAlign: 'right' } },
                            String(run.episodes),
                          ),
                          h(
                            'td',
                            {
                              className: 'ml-tabular',
                              style: { textAlign: 'right', fontWeight: 600 },
                            },
                            String(run.committed),
                          ),
                          h(
                            'td',
                            null,
                            h(
                              'span',
                              {
                                style: {
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  color: statusColor,
                                  fontWeight: 500,
                                },
                              },
                              h('span', {
                                className: 'ml-host-dot',
                                style: { background: statusColor },
                              }),
                              run.status,
                            ),
                          ),
                          h(
                            'td',
                            { style: { textAlign: 'right' } },
                            run.status === 'completed'
                              ? h(
                                  Button,
                                  {
                                    size: 'sm',
                                    disabled: !(activeClient?.writable ?? false) || undoBusy,
                                    onClick: () => setConfirmUndo(run),
                                  },
                                  t('dream.undo'),
                                )
                              : h('span', { style: { color: 'var(--ml-text-muted)' } }, '—'),
                          ),
                        )
                      }),
                    ),
                  ),
                )
            : h(
                'div',
                { className: 'ml-canvas-container' },
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
                  h('input', {
                    type: 'text',
                    className: 'ml-input',
                    placeholder: t('desktop.audit.filterMemoryId'),
                    value: memoryIdFilter,
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                      setMemoryIdFilter(e.target.value),
                  }),
                  h('input', {
                    type: 'text',
                    className: 'ml-input',
                    placeholder: t('desktop.audit.filterDreamId'),
                    value: dreamIdFilter,
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                      setDreamIdFilter(e.target.value),
                  }),
                ),
                filteredAudits.length === 0
                  ? h(EmptyBlock, { icon: Icons.history(), title: t('desktop.audit.empty') })
                  : filteredAudits.map((rec) => {
                      const expanded = expandedAuditIds[rec.id] === true
                      const hasDiff = rec.before !== undefined || rec.after !== undefined
                      return h(
                        'div',
                        {
                          key: rec.id,
                          className: 'ml-surface-card',
                          style: {
                            padding: '16px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '10px',
                          },
                        },
                        h(
                          'div',
                          {
                            style: {
                              display: 'flex',
                              alignItems: 'flex-start',
                              justifyContent: 'space-between',
                              gap: '12px',
                            },
                          },
                          h(
                            'div',
                            {
                              style: {
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '10px',
                                minWidth: 0,
                              },
                            },
                            h('span', {
                              className: 'ml-host-dot',
                              style: {
                                marginTop: '6px',
                                background:
                                  rec.action === 'dream-undo' || rec.action === 'reject'
                                    ? 'var(--ml-warn)'
                                    : 'var(--ml-copper)',
                              },
                            }),
                            h(
                              'div',
                              { style: { minWidth: 0 } },
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
                                activeClient !== undefined
                                  ? h(HostTag, {
                                      kind: activeClient.kind,
                                      label: activeClient.name,
                                    })
                                  : null,
                                h(
                                  'span',
                                  {
                                    className: 'ml-mono',
                                    style: {
                                      padding: '2px 8px',
                                      borderRadius: '6px',
                                      background: 'var(--ml-recessed)',
                                      fontSize: '12px',
                                    },
                                  },
                                  rec.action,
                                ),
                                h(
                                  'span',
                                  { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                                  `${t('desktop.audit.actor')}: ${rec.actor}`,
                                ),
                              ),
                              h(
                                'div',
                                {
                                  className: 'ml-mono',
                                  style: {
                                    fontSize: '12px',
                                    color: 'var(--ml-text-secondary)',
                                    marginTop: '6px',
                                  },
                                },
                                `${rec.memoryId}${rec.dreamId !== undefined ? ` · ${rec.dreamId}` : ''}`,
                              ),
                            ),
                          ),
                          h(
                            'div',
                            {
                              style: {
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                flex: 'none',
                              },
                            },
                            h(
                              'span',
                              {
                                className: 'ml-tabular',
                                style: { fontSize: '12px', color: 'var(--ml-text-muted)' },
                              },
                              formatTime(rec.at),
                            ),
                            hasDiff
                              ? h(
                                  Button,
                                  {
                                    size: 'sm',
                                    onClick: () =>
                                      setExpandedAuditIds((prev) => ({
                                        ...prev,
                                        [rec.id]: !expanded,
                                      })),
                                  },
                                  expanded
                                    ? t('desktop.audit.hideDiff')
                                    : t('desktop.audit.showDiff'),
                                )
                              : null,
                          ),
                        ),
                        expanded && hasDiff
                          ? h(
                              'div',
                              { className: 'ml-diff-box' },
                              h(
                                'div',
                                { className: 'ml-diff-grid' },
                                h(
                                  'div',
                                  { className: 'ml-diff-col' },
                                  h(
                                    'div',
                                    {
                                      style: {
                                        fontSize: '12px',
                                        fontWeight: 600,
                                        color: 'var(--ml-text-muted)',
                                      },
                                    },
                                    t('desktop.audit.before'),
                                  ),
                                  h(
                                    'pre',
                                    {
                                      className: 'ml-mono',
                                      style: {
                                        margin: 0,
                                        fontSize: '12px',
                                        whiteSpace: 'pre-wrap',
                                      },
                                    },
                                    JSON.stringify(rec.before ?? null, null, 2),
                                  ),
                                ),
                                h(
                                  'div',
                                  { className: 'ml-diff-col' },
                                  h(
                                    'div',
                                    {
                                      style: {
                                        fontSize: '12px',
                                        fontWeight: 600,
                                        color: 'var(--ml-text-muted)',
                                      },
                                    },
                                    t('desktop.audit.after'),
                                  ),
                                  h(
                                    'pre',
                                    {
                                      className: 'ml-mono',
                                      style: {
                                        margin: 0,
                                        fontSize: '12px',
                                        whiteSpace: 'pre-wrap',
                                      },
                                    },
                                    JSON.stringify(rec.after ?? null, null, 2),
                                  ),
                                ),
                              ),
                            )
                          : null,
                      )
                    }),
              ),
    ),

    confirmUndo !== undefined
      ? h(
          Modal,
          {
            title: t('dream.undo'),
            closeLabel: t('common.close'),
            maxWidth: 440,
            onClose: () => setConfirmUndo(undefined),
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { disabled: undoBusy, onClick: () => setConfirmUndo(undefined) },
                t('common.cancel'),
              ),
              h(
                Button,
                { variant: 'warn', disabled: undoBusy, onClick: () => void executeUndo() },
                t('common.confirm'),
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
            formatMessage('desktop.dream.undoConfirm', { id: confirmUndo.id }),
          ),
        )
      : null,
  )
}
