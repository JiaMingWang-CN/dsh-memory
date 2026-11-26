/**
 * Dream run history (with batch undo) and read-only audit timeline panel.
 * @module memloom/desktop/renderer/DreamAuditPanel
 */
import * as React from 'react'
import { diffLines } from '../../client/diff.ts'
import { formatRelativeTime } from '../../client/MemoryList.tsx'
import { formatMessage, t } from '../../client/locales.ts'
import { MemoryEmptyState, MemoryErrorState, MemoryLoadingState } from '../../client/styles.ts'
import { Button, Select, Tag } from '../../client/ui.tsx'
import type { AuditAction, AuditRecord, DreamRun } from '../../shared/types.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'

const h = React.createElement

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

export interface DreamAuditPanelProps {
  readonly bridge: DesktopBridgeApi
  readonly clientId: string
  readonly writable: boolean
  readonly refreshToken: number
  readonly onDataChanged: () => void | Promise<void>
  readonly onExternalChange: () => void
}

function dreamStatusTone(status: DreamRun['status']): 'success' | 'error' | 'warn' | 'neutral' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'running' || status === 'queued') return 'warn'
  return 'neutral'
}

/**
 * Render DreamRun history (with per-batch undoDream) and read-only audit timeline.
 */
export function DreamAuditPanel(props: DreamAuditPanelProps): React.ReactElement {
  const { bridge, clientId, writable, refreshToken } = props
  const [dreams, setDreams] = React.useState<DreamRun[]>([])
  const [auditItems, setAuditItems] = React.useState<AuditRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [undoBusyId, setUndoBusyId] = React.useState<string | undefined>(undefined)

  const [actionFilter, setActionFilter] = React.useState<string>('all')
  const [memoryIdFilter, setMemoryIdFilter] = React.useState('')
  const [dreamIdFilter, setDreamIdFilter] = React.useState('')
  const [expandedAuditIds, setExpandedAuditIds] = React.useState<Record<string, boolean>>({})
  const [localReload, setLocalReload] = React.useState(0)
  const hasLoaded = React.useRef(false)

  React.useEffect(() => {
    hasLoaded.current = false
  }, [clientId])

  React.useEffect(() => {
    let cancelled = false
    if (!hasLoaded.current) {
      setLoading(true)
    }
    setError('')
    const memId = memoryIdFilter.trim()
    const drmId = dreamIdFilter.trim()
    Promise.all([
      bridge.memory.listDreams({ clientId, limit: 50 }),
      bridge.memory.listAudit({
        clientId,
        ...(memId !== '' ? { memoryId: memId } : {}),
        ...(drmId !== '' ? { dreamId: drmId } : {}),
        limit: 200,
      }),
    ])
      .then(([dreamsRes, auditRes]) => {
        if (cancelled) return
        hasLoaded.current = true
        setDreams(unwrapIpc(dreamsRes))
        setAuditItems(unwrapIpc(auditRes).items)
      })
      .catch((reason) => {
        if (cancelled) return
        if (isExternalChangeError(reason)) props.onExternalChange()
        setError(desktopErrorText(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bridge, clientId, memoryIdFilter, dreamIdFilter, refreshToken, localReload])

  const filteredAudit = React.useMemo(() => {
    if (actionFilter === 'all') return auditItems
    return auditItems.filter((item) => item.action === actionFilter)
  }, [auditItems, actionFilter])

  const handleUndoDream = async (dreamId: string): Promise<void> => {
    if (!writable || undoBusyId !== undefined) return
    setUndoBusyId(dreamId)
    setError('')
    setNotice('')
    try {
      const report = unwrapIpc(await bridge.memory.undoDream({ clientId, dreamId }))
      setNotice(
        formatMessage('dream.undoResult', { undone: report.undone, skipped: report.skipped }),
      )
      setLocalReload((v) => v + 1)
      await props.onDataChanged()
    } catch (reason) {
      if (isExternalChangeError(reason)) props.onExternalChange()
      setError(desktopErrorText(reason))
    } finally {
      setUndoBusyId(undefined)
    }
  }

  const toggleDiff = (id: string): void => {
    setExpandedAuditIds((current) => ({ ...current, [id]: !current[id] }))
  }

  if (loading) {
    return h(MemoryLoadingState)
  }

  return h(
    'div',
    { className: 'dsh-mem-stack' },
    h('div', { className: 'dsh-mem-warning', role: 'note' }, t('desktop.dream.hostHint')),
    error !== ''
      ? h(MemoryErrorState, { message: error, onRetry: () => setLocalReload((v) => v + 1) })
      : null,
    notice !== '' ? h('div', { className: 'dsh-mem-notice', role: 'status' }, notice) : null,

    // DreamRun history card
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h(
        'div',
        { className: 'dsh-mem-section-head' },
        h('h3', { className: 'dsh-mem-section-title' }, t('desktop.dream.historyTitle')),
        h(Tag, null, String(dreams.length)),
      ),
      dreams.length === 0
        ? h('p', { className: 'dsh-mem-hint' }, t('desktop.dream.empty'))
        : h(
            'div',
            { className: 'memloom-timeline-list' },
            dreams.map((run) => {
              const stamp = formatRelativeTime(run.finishedAt ?? run.startedAt)
              const modelLabel =
                run.provider !== '' && run.model !== ''
                  ? `${run.provider} / ${run.model}`
                  : run.model || run.provider || '—'
              return h(
                'div',
                { key: run.id, className: 'memloom-timeline-item' },
                h(
                  'div',
                  { className: 'memloom-timeline-head' },
                  h(
                    'div',
                    { className: 'dsh-mem-detail-tags' },
                    h('strong', null, run.id),
                    h(Tag, { tone: dreamStatusTone(run.status) }, t(`dream.${run.status}`)),
                    h(Tag, null, `${t('desktop.dream.trigger')}: ${run.trigger}`),
                    h(Tag, null, `${t('desktop.dream.scope')}: ${run.scopeKey}`),
                  ),
                  run.status === 'completed'
                    ? h(
                        Button,
                        {
                          size: 'sm',
                          disabled: !writable || undoBusyId !== undefined,
                          ...(writable ? {} : { title: t('desktop.dream.readonlyUndoHint') }),
                          onClick: () => {
                            void handleUndoDream(run.id)
                          },
                        },
                        t('dream.undo'),
                      )
                    : null,
                ),
                h(
                  'dl',
                  { className: 'dsh-mem-facts' },
                  h(
                    'div',
                    { className: 'dsh-mem-fact' },
                    h('dt', null, t('dream.model')),
                    h('dd', null, modelLabel),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-fact' },
                    h('dt', null, t('dream.episodes')),
                    h('dd', null, String(run.episodes)),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-fact' },
                    h('dt', null, t('dream.committed')),
                    h('dd', null, String(run.committed)),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-fact' },
                    h('dt', null, t('dream.pendingCount')),
                    h('dd', null, String(run.pending)),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-fact' },
                    h('dt', null, t('dream.time')),
                    h('dd', { title: stamp.full }, stamp.short),
                  ),
                ),
                run.error !== undefined && run.error !== ''
                  ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, run.error)
                  : null,
              )
            }),
          ),
    ),

    // Read-only audit timeline card
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h(
        'div',
        { className: 'dsh-mem-section-head' },
        h('h3', { className: 'dsh-mem-section-title' }, t('desktop.audit.title')),
        h(Tag, null, String(filteredAudit.length)),
      ),
      h(
        'div',
        { className: 'dsh-mem-search-row' },
        h(Select, {
          label: t('desktop.audit.filterAction'),
          value: actionFilter,
          options: [
            { value: 'all', label: t('desktop.audit.allActions') },
            ...AUDIT_ACTIONS.map((action) => ({ value: action, label: action })),
          ],
          onChange: setActionFilter,
        }),
        h('input', {
          type: 'text',
          className: 'dsh-mem-input',
          style: { flex: '1 1 160px', maxWidth: '240px' },
          'aria-label': t('desktop.audit.filterMemoryId'),
          placeholder: t('desktop.audit.filterMemoryId'),
          value: memoryIdFilter,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setMemoryIdFilter(event.target.value),
        }),
        h('input', {
          type: 'text',
          className: 'dsh-mem-input',
          style: { flex: '1 1 160px', maxWidth: '240px' },
          'aria-label': t('desktop.audit.filterDreamId'),
          placeholder: t('desktop.audit.filterDreamId'),
          value: dreamIdFilter,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setDreamIdFilter(event.target.value),
        }),
      ),
      filteredAudit.length === 0
        ? h(MemoryEmptyState, { description: t('desktop.audit.empty') })
        : h(
            'div',
            { className: 'memloom-timeline-list' },
            filteredAudit.map((entry) => {
              const stamp = formatRelativeTime(entry.at)
              const hasPayload = entry.before != null || entry.after != null
              const expanded = expandedAuditIds[entry.id] === true
              return h(
                'div',
                { key: entry.id, className: 'memloom-timeline-item' },
                h(
                  'div',
                  { className: 'memloom-timeline-head' },
                  h(
                    'div',
                    { className: 'dsh-mem-detail-tags' },
                    h(Tag, { tone: 'accent' }, entry.action),
                    h(Tag, null, `${t('desktop.audit.actor')}: ${entry.actor}`),
                    h(Tag, { tone: entry.status === 'undone' ? 'warn' : 'success' }, entry.status),
                    entry.memoryId !== undefined ? h(Tag, null, `memory:${entry.memoryId}`) : null,
                    entry.dreamId !== undefined ? h(Tag, null, `dream:${entry.dreamId}`) : null,
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-actions' },
                    h('span', { className: 'dsh-mem-count', title: stamp.full }, stamp.short),
                    hasPayload
                      ? h(
                          Button,
                          {
                            size: 'sm',
                            variant: 'ghost',
                            onClick: () => toggleDiff(entry.id),
                          },
                          expanded ? t('desktop.audit.hideDiff') : t('desktop.audit.showDiff'),
                        )
                      : null,
                  ),
                ),
                entry.reason !== undefined && entry.reason !== ''
                  ? h('p', { className: 'dsh-mem-hint' }, entry.reason)
                  : null,
                expanded && hasPayload
                  ? h(
                      'div',
                      { className: 'dsh-mem-diff' },
                      diffLines(
                        entry.before ? `${entry.before.title}\n${entry.before.body}` : '',
                        entry.after ? `${entry.after.title}\n${entry.after.body}` : '',
                      ).map((line, index) =>
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
                  : null,
              )
            }),
          ),
    ),
  )
}
