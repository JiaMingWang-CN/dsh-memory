/**
 * Cross-host Dream Review Inbox with supersedes diff/side-by-side comparison,
 * edit-before-accept flow, and keyboard shortcuts (A / E / R).
 * @module memloom/desktop/renderer/ReviewView
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import type { MemoryRecord } from '../../shared/types.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type { DesktopClientInfo } from '../multi-service.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'
import {
  Button,
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
} from './ui.tsx'

const h = React.createElement

export interface ReviewViewProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly refreshToken: number
  readonly banners?: React.ReactNode
  readonly onDataChanged: () => Promise<void>
  readonly onExternalChange: () => void
  readonly onPendingCountChange: (count: number) => void
  readonly onOpenMemories: () => void
  readonly onNotify: (message: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void
}

interface PendingProposalItem {
  readonly clientId: string
  readonly clientName: string
  readonly clientKind: DesktopClientInfo['kind']
  readonly writable: boolean
  readonly record: MemoryRecord
}

export function ReviewView(props: ReviewViewProps): React.ReactElement {
  const { bridge, clients, refreshToken, onPendingCountChange } = props
  const [hostFilter, setHostFilter] = React.useState<'all' | 'agy' | 'dsh'>('all')
  const [proposals, setProposals] = React.useState<PendingProposalItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selectedKey, setSelectedKey] = React.useState<string | undefined>(undefined)
  const [superseded, setSuperseded] = React.useState<readonly MemoryRecord[]>([])
  const [busy, setBusy] = React.useState(false)
  const [editModal, setEditModal] = React.useState<PendingProposalItem | undefined>(undefined)
  const [localReload, setLocalReload] = React.useState(0)

  const healthyClients = React.useMemo(
    () => clients.filter((c) => c.enabled && c.health === 'ready'),
    [clients],
  )

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all(
      healthyClients.map(async (client) => {
        try {
          const res = unwrapIpc(
            await bridge.memory.list({
              clientId: client.id,
              status: 'pending',
              limit: 50,
              management: true,
            }),
          )
          return res.items.map((record) => ({
            clientId: client.id,
            clientName: client.name,
            clientKind: client.kind,
            writable: client.writable,
            record,
          }))
        } catch {
          return []
        }
      }),
    )
      .then((groups) => {
        if (cancelled) return
        const flat = groups
          .flat()
          .sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))
        setProposals(flat)
        onPendingCountChange(flat.length)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bridge, healthyClients, refreshToken, localReload, onPendingCountChange])

  const filtered = React.useMemo(() => {
    if (hostFilter === 'all') return proposals
    return proposals.filter((p) => p.clientKind === hostFilter)
  }, [proposals, hostFilter])

  React.useEffect(() => {
    if (filtered.length === 0) {
      setSelectedKey(undefined)
      return
    }
    if (
      selectedKey === undefined ||
      !filtered.some((p) => `${p.clientId}:${p.record.id}` === selectedKey)
    ) {
      const first = filtered[0]
      if (first !== undefined) setSelectedKey(`${first.clientId}:${first.record.id}`)
    }
  }, [filtered, selectedKey])

  const current =
    selectedKey !== undefined
      ? filtered.find((p) => `${p.clientId}:${p.record.id}` === selectedKey)
      : undefined

  React.useEffect(() => {
    if (current === undefined || current.record.supersedes.length === 0) {
      setSuperseded([])
      return undefined
    }
    let cancelled = false
    Promise.all(
      current.record.supersedes.map(async (id) => {
        try {
          const view = unwrapIpc(await bridge.memory.view({ clientId: current.clientId, id }))
          return view.record
        } catch {
          return undefined
        }
      }),
    ).then((list) => {
      if (!cancelled) setSuperseded(list.filter((r): r is MemoryRecord => r !== undefined))
    })
    return () => {
      cancelled = true
    }
  }, [bridge, current])

  const handleReview = React.useCallback(
    async (item: PendingProposalItem, action: 'accept' | 'reject'): Promise<void> => {
      if (!item.writable || busy) {
        if (!item.writable) props.onNotify(t('desktop.review.readonlyNotice'), 'warn')
        return
      }
      setBusy(true)
      try {
        unwrapIpc(
          await bridge.memory.review({ clientId: item.clientId, id: item.record.id, action }),
        )
        setLocalReload((v) => v + 1)
        await props.onDataChanged()
        props.onNotify(action === 'accept' ? t('review.accepted') : t('review.rejected'), 'success')
      } catch (err) {
        if (isExternalChangeError(err)) props.onExternalChange()
        props.onNotify(desktopErrorText(err), 'danger')
      } finally {
        setBusy(false)
      }
    },
    [bridge, busy, props],
  )

  // Keyboard shortcuts: A (accept), E (edit & accept), R (reject)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (current === undefined || editModal !== undefined) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const key = event.key.toLowerCase()
      if (key === 'a') {
        event.preventDefault()
        void handleReview(current, 'accept')
      } else if (key === 'e') {
        event.preventDefault()
        if (!current.writable) props.onNotify(t('desktop.review.readonlyNotice'), 'warn')
        else setEditModal(current)
      } else if (key === 'r') {
        event.preventDefault()
        void handleReview(current, 'reject')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [current, editModal, handleReview, props])

  return h(
    React.Fragment,
    null,
    h(
      'header',
      { className: 'ml-stage-header' },
      h(
        'div',
        { className: 'ml-stage-title-group' },
        h('h1', { className: 'ml-stage-title' }, t('desktop.nav.review')),
        h(
          'span',
          {
            className: 'ml-tabular',
            style: {
              padding: '2px 9px',
              borderRadius: '999px',
              background: 'var(--ml-recessed)',
              color: 'var(--ml-text-secondary)',
              fontSize: '12px',
              fontWeight: 500,
            },
          },
          formatMessage('desktop.review.pendingCount', { count: filtered.length }),
        ),
      ),
      h(SegmentedControl<'all' | 'agy' | 'dsh'>, {
        label: t('desktop.filter.hostPrefix'),
        value: hostFilter,
        onChange: setHostFilter,
        items: [
          { id: 'all', label: t('desktop.allHosts') },
          {
            id: 'agy',
            label: h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              h(HostLogo, { kind: 'agy', size: 13 }),
              h('span', null, t('desktop.kind.agy')),
            ),
          },
          {
            id: 'dsh',
            label: h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              h(HostLogo, { kind: 'dsh', size: 13 }),
              h('span', null, t('desktop.kind.dsh')),
            ),
          },
        ],
      }),
    ),

    props.banners ?? null,

    loading
      ? h(EmptyBlock, { title: t('state.loading') })
      : filtered.length === 0
        ? h(EmptyBlock, {
            icon: Icons.check(),
            title: t('review.none'),
            description: t('desktop.review.subtitle'),
            action: h(
              Button,
              { variant: 'surface', onClick: props.onOpenMemories },
              t('desktop.review.backToMemories'),
            ),
          })
        : h(
            'div',
            { className: 'ml-split' },
            h(
              'div',
              { className: 'ml-queue-pane ml-scroll', role: 'list' },
              filtered.map((item) => {
                const key = `${item.clientId}:${item.record.id}`
                const isReplace = item.record.supersedes.length > 0
                return h(
                  'div',
                  {
                    key,
                    role: 'listitem',
                    className: 'ml-queue-item',
                    'data-selected': key === selectedKey,
                    onClick: () => setSelectedKey(key),
                  },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        marginBottom: '6px',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      h(HostTag, { kind: item.clientKind, label: item.clientName }),
                      h(
                        'span',
                        {
                          style: {
                            fontSize: '12px',
                            fontWeight: 500,
                            color: isReplace ? 'var(--ml-warn)' : 'var(--ml-text-muted)',
                          },
                        },
                        isReplace ? t('desktop.review.typeReplace') : t('desktop.review.typeNew'),
                      ),
                    ),
                    h(
                      'span',
                      {
                        className: 'ml-tabular',
                        style: { fontSize: '12px', color: 'var(--ml-text-muted)' },
                      },
                      `${Math.round(item.record.confidence * 100)}%`,
                    ),
                  ),
                  h(
                    'div',
                    { style: { fontSize: '13px', fontWeight: 500, lineHeight: 1.4 } },
                    item.record.title,
                  ),
                )
              }),
            ),

            current !== undefined
              ? h(
                  'div',
                  {
                    style: {
                      flex: '1 1 auto',
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      background: 'var(--ml-panel-bg)',
                    },
                  },
                  h(
                    'div',
                    { className: 'ml-inspector-scroll ml-scroll' },
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          alignItems: 'flex-start',
                          justifyContent: 'space-between',
                          gap: '16px',
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        h(
                          'div',
                          {
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              flexWrap: 'wrap',
                            },
                          },
                          h(HostTag, { kind: current.clientKind, label: current.clientName }),
                          h(TypeTag, {
                            type: current.record.type,
                            label: t(`type.${current.record.type}`),
                          }),
                          h(
                            'span',
                            { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                            current.record.scope.kind === 'global'
                              ? t('scope.global')
                              : current.record.scope.root,
                          ),
                        ),
                        h(
                          'h2',
                          { style: { margin: 0, fontSize: '17px', fontWeight: 600 } },
                          current.record.title,
                        ),
                      ),
                      h(
                        'div',
                        {
                          className: 'ml-surface-card',
                          style: { padding: '8px 14px', textAlign: 'right', flex: 'none' },
                        },
                        h(
                          'div',
                          { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                          t('detail.confidence'),
                        ),
                        h(
                          'div',
                          {
                            className: 'ml-tabular',
                            style: { fontSize: '16px', fontWeight: 600, color: 'var(--ml-copper)' },
                          },
                          `${Math.round(current.record.confidence * 100)}%`,
                        ),
                      ),
                    ),

                    superseded.length > 0
                      ? h(
                          'div',
                          { className: 'ml-diff-box' },
                          h(
                            'div',
                            {
                              className: 'ml-banner',
                              'data-tone': 'warn',
                              style: { borderBottom: '1px solid var(--ml-warn-border)' },
                            },
                            h(
                              'span',
                              { style: { fontWeight: 500, color: 'var(--ml-warn)' } },
                              t('desktop.review.diffBanner'),
                            ),
                            h(
                              'span',
                              { className: 'ml-mono' },
                              current.record.supersedes.join(', '),
                            ),
                          ),
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
                                    color: 'var(--ml-danger)',
                                  },
                                },
                                t('review.oldVersion'),
                              ),
                              h(
                                'div',
                                { style: { fontSize: '13px', fontWeight: 600 } },
                                superseded[0]!.title,
                              ),
                              h(MarkdownProse, { text: superseded[0]!.body, compact: true }),
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
                                    color: 'var(--ml-success)',
                                  },
                                },
                                t('review.newVersion'),
                              ),
                              h(
                                'div',
                                { style: { fontSize: '13px', fontWeight: 600 } },
                                current.record.title,
                              ),
                              h(MarkdownProse, { text: current.record.body, compact: true }),
                            ),
                          ),
                        )
                      : h(
                          'div',
                          { className: 'ml-surface-card', style: { padding: '18px' } },
                          h(MarkdownProse, { text: current.record.body }),
                        ),

                    current.record.sourceRefs.length > 0
                      ? h(
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
                            t('detail.sources'),
                          ),
                          current.record.sourceRefs.map((ref, idx) =>
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
                                  gap: '4px',
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
                                ? h('div', null, ref.quote)
                                : null,
                            ),
                          ),
                        )
                      : null,
                  ),

                  h(
                    'div',
                    { className: 'ml-inspector-footer' },
                    h(
                      'span',
                      {
                        style: {
                          fontSize: '12px',
                          color: current.writable ? 'var(--ml-text-muted)' : 'var(--ml-warn)',
                        },
                      },
                      current.writable
                        ? t('desktop.review.shortcuts')
                        : t('desktop.review.readonlyNotice'),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      h(
                        Button,
                        {
                          disabled: !current.writable || busy,
                          onClick: () => void handleReview(current, 'reject'),
                        },
                        h('span', { style: { color: 'var(--ml-danger)' } }, t('review.reject')),
                        h('span', { className: 'ml-kbd' }, 'R'),
                      ),
                      h(
                        Button,
                        {
                          disabled: !current.writable || busy,
                          onClick: () => setEditModal(current),
                        },
                        h('span', null, t('review.editBeforeAccept')),
                        h('span', { className: 'ml-kbd' }, 'E'),
                      ),
                      h(
                        Button,
                        {
                          variant: 'primary',
                          disabled: !current.writable || busy,
                          onClick: () => void handleReview(current, 'accept'),
                        },
                        h('span', null, t('desktop.review.approveAndKeep')),
                        h(
                          'span',
                          {
                            className: 'ml-mono',
                            style: {
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'rgba(255,255,255,0.2)',
                              fontSize: '12px',
                            },
                          },
                          'A',
                        ),
                      ),
                    ),
                  ),
                )
              : null,
          ),

    editModal !== undefined
      ? h(ProposalEditAcceptModal, {
          bridge,
          item: editModal,
          onClose: () => setEditModal(undefined),
          onExternalChange: props.onExternalChange,
          onAccepted: async () => {
            setEditModal(undefined)
            setLocalReload((v) => v + 1)
            await props.onDataChanged()
            props.onNotify(t('review.accepted'), 'success')
          },
        })
      : null,
  )
}

function ProposalEditAcceptModal(props: {
  readonly bridge: DesktopBridgeApi
  readonly item: PendingProposalItem
  readonly onClose: () => void
  readonly onExternalChange: () => void
  readonly onAccepted: () => Promise<void>
}): React.ReactElement {
  const [title, setTitle] = React.useState(props.item.record.title)
  const [body, setBody] = React.useState(props.item.record.body)
  const [tagsText, setTagsText] = React.useState(props.item.record.tags.join(', '))
  const [pinned, setPinned] = React.useState(props.item.record.pinned)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  const saveAndAccept = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const tags = tagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      unwrapIpc(
        await props.bridge.memory.update({
          clientId: props.item.clientId,
          id: props.item.record.id,
          expectedContentRevision: props.item.record.contentRevision,
          title: title.trim(),
          body,
          tags,
          pinned,
        }),
      )
      unwrapIpc(
        await props.bridge.memory.review({
          clientId: props.item.clientId,
          id: props.item.record.id,
          action: 'accept',
        }),
      )
      await props.onAccepted()
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      setError(desktopErrorText(err))
    } finally {
      setSaving(false)
    }
  }

  return h(
    Modal,
    {
      title: t('review.editBeforeAccept'),
      closeLabel: t('common.close'),
      onClose: props.onClose,
      footer: h(
        React.Fragment,
        null,
        h(Button, { disabled: saving, onClick: props.onClose }, t('common.cancel')),
        h(
          Button,
          { variant: 'primary', disabled: saving, onClick: () => void saveAndAccept() },
          saving ? t('common.saving') : t('review.saveAndAccept'),
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
              style: { borderRadius: '8px', border: '1px solid var(--ml-danger-border)' },
            },
            error,
          )
        : null,
      h(TextField, { label: t('detail.title'), value: title, onChange: setTitle }),
      h(TextField, {
        label: t('detail.body'),
        value: body,
        multiline: true,
        rows: 5,
        onChange: setBody,
      }),
      h(TextField, { label: t('detail.tags'), value: tagsText, onChange: setTagsText }),
      h(Switch, { label: t('detail.pinned'), checked: pinned, onChange: setPinned }),
    ),
  )
}
