/**
 * Pending-proposal review panel.
 *
 * Shows dream proposals awaiting review with metadata badges and the records
 * they would supersede. Accept/Reject/Edit-before-accept are delegated to the
 * section, which owns the Remote calls and audit trail.
 * @module memloom/client/ReviewPanel
 */
import * as React from 'react'
import type { MemoryRecord } from './context.ts'
import { formatMessage, t } from './locales.ts'
import { Button, Tag } from './ui.tsx'

const h = React.createElement

/** Props accepted by {@link ReviewPanel}. */
export interface ReviewPanelProps {
  pending: MemoryRecord[]
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onEdit: (id: string) => void
  /** Open the full proposal in a dialog; when omitted the card is static. */
  onOpen?: (record: MemoryRecord) => void
  /** A review action is in flight; quick actions are disabled. */
  busy?: boolean
}

/**
 * Render the pending-proposal list.
 * @param props - Pending records and review callbacks.
 * @returns The review panel element.
 */
export function ReviewPanel(props: ReviewPanelProps): React.ReactElement {
  return h(
    'section',
    { className: 'dsh-mem-section-card' },
    h(
      'div',
      { className: 'dsh-mem-section-head' },
      h(
        'div',
        null,
        h('h3', { className: 'dsh-mem-section-title' }, t('review.title')),
        h('p', { className: 'dsh-mem-section-sub' }, t('review.subtitle')),
      ),
      props.pending.length > 0 ? h(Tag, { tone: 'warn' }, String(props.pending.length)) : null,
    ),
    props.pending.length === 0
      ? h('p', { className: 'dsh-mem-hint' }, t('review.none'))
      : props.pending.map((record) =>
          h(
            'div',
            {
              key: record.id,
              className: 'dsh-mem-proposal',
              ...(props.onOpen === undefined
                ? {}
                : {
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => props.onOpen?.(record),
                    onKeyDown: (event: React.KeyboardEvent) => {
                      // Only the card itself opens the dialog; a key pressed on
                      // an inner quick-action button must keep its own behavior.
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        props.onOpen?.(record)
                      }
                    },
                  }),
            },
            h('span', { className: 'dsh-mem-proposal-title' }, record.title),
            h(
              'div',
              { className: 'dsh-mem-detail-tags' },
              h(Tag, null, t(`type.${record.type}`)),
              h(
                Tag,
                null,
                record.scope.kind === 'global' ? t('scope.global') : t('scope.workspace'),
              ),
              h(Tag, null, `${t('detail.importance')} ${record.importance}`),
              h(Tag, null, `${t('detail.confidence')} ${record.confidence}`),
              record.supersedes.length > 0
                ? h(
                    Tag,
                    { tone: 'warn' },
                    formatMessage('review.replacesCount', { count: record.supersedes.length }),
                  )
                : null,
            ),
            h('span', { className: 'dsh-mem-proposal-body' }, record.body.slice(0, 220)),
            record.supersedes.length === 0
              ? null
              : h(
                  'span',
                  { className: 'dsh-mem-hint' },
                  `${t('review.supersedes')}: ${record.supersedes.join(', ')}`,
                ),
            h(
              'div',
              {
                className: 'dsh-mem-actions',
                // Quick actions must not also open the proposal dialog.
                onClick: (event: React.MouseEvent) => event.stopPropagation(),
              },
              h(
                Button,
                {
                  variant: 'primary',
                  size: 'sm',
                  ...(props.busy === true ? { disabled: true } : {}),
                  onClick: () => props.onAccept(record.id),
                },
                t('review.accept'),
              ),
              h(
                Button,
                {
                  size: 'sm',
                  ...(props.busy === true ? { disabled: true } : {}),
                  onClick: () => props.onReject(record.id),
                },
                t('review.reject'),
              ),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  ...(props.busy === true ? { disabled: true } : {}),
                  onClick: () => props.onEdit(record.id),
                },
                t('review.editBeforeAccept'),
              ),
            ),
          ),
        ),
  )
}
