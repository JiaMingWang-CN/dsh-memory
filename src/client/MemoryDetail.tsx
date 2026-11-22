/**
 * Detail panel: read view plus edit, delete and restore actions.
 *
 * The panel owns draft state so a failed save can keep the user's text. A
 * `memory/conflict` failure is surfaced as a reload prompt instead of silently
 * overwriting either side. Nothing here calls the Remote directly: the section
 * owns every call and reports failures back into the panel.
 * @module dsh-memory/client/MemoryDetail
 */
import * as React from 'react'
import type { MemoryRecord, MemorySourceRef } from './context.ts'
import { draftFromRecord, MemoryEditor, type MemoryDraft } from './MemoryEditor.tsx'
import { errorText, isConflict } from './errors.ts'
import { t } from './locales.ts'
import { Button, Tag } from './ui.tsx'

const h = React.createElement

/** Props accepted by {@link MemoryDetail}. */
export interface MemoryDetailProps {
  record: MemoryRecord
  sources?: MemorySourceRef[]
  onSave?: (draft: MemoryDraft) => Promise<void> | void
  onDelete?: () => Promise<void> | void
  onRestore?: () => Promise<void> | void
  /** Re-read this record from the Host (conflict recovery). */
  onReload?: () => Promise<void> | void
  /** Report whether the editor holds unsaved text, so closing can confirm. */
  onDirtyChange?: (dirty: boolean) => void
  deleting?: boolean
  restoring?: boolean
  /** Render inside a Modal with a scrollable body, pinned footer, and no duplicated title. */
  inModal?: boolean
  /** Start directly in edit mode (e.g. "Edit before accept" from proposal review). */
  initialEditing?: boolean
  /** Optional custom label for the primary save button. */
  saveLabel?: string
  /** Optional cancel override when started directly in edit mode. */
  onCancelEdit?: () => void
}

/** Facts worth a label/value pair under the body. */
function facts(record: MemoryRecord): Array<{ label: string; value: string }> {
  return [
    { label: t('detail.importance'), value: String(record.importance) },
    { label: t('detail.confidence'), value: String(record.confidence) },
    { label: t('detail.matchCount'), value: String(record.matchCount) },
    { label: t('detail.useCount'), value: String(record.useCount) },
    { label: t('detail.revision'), value: String(record.contentRevision) },
  ]
}

/** Whether a draft differs from the stored record. */
function draftChanged(draft: MemoryDraft, record: MemoryRecord): boolean {
  return (
    draft.title !== record.title ||
    draft.body !== record.body ||
    draft.tags.join('\u0000') !== record.tags.join('\u0000') ||
    draft.importance !== record.importance ||
    draft.pinned !== record.pinned
  )
}

/** Shorten long session UUIDs while keeping them identifiable. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

/** Best-effort clipboard write without throwing in restricted WebViews. */
async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Render one memory detail.
 * @param props - Record plus action callbacks.
 * @returns The detail element.
 */
export function MemoryDetail(props: MemoryDetailProps): React.ReactElement {
  const { record } = props
  const [editing, setEditing] = React.useState(props.initialEditing === true)
  const [draft, setDraft] = React.useState<MemoryDraft>(() => draftFromRecord(record))
  const [saving, setSaving] = React.useState(false)
  const [reloading, setReloading] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [saveError, setSaveError] = React.useState('')
  const [actionError, setActionError] = React.useState('')
  const [confirmingArchive, setConfirmingArchive] = React.useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false)
  const [copiedKey, setCopiedKey] = React.useState<string | undefined>(undefined)

  const dirty = editing && draftChanged(draft, record)
  React.useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty, props.onDirtyChange])

  // The dialog and the editor always describe the record currently rendered.
  React.useEffect(() => {
    if (!editing) setDraft(draftFromRecord(record))
  }, [record, editing])

  const flashCopied = (key: string): void => {
    setCopiedKey(key)
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? undefined : current))
      }, 1_600)
    }
  }

  const beginEdit = (): void => {
    setDraft(draftFromRecord(record))
    setConflict(false)
    setSaveError('')
    setConfirmingDiscard(false)
    setConfirmingArchive(false)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    if (dirty && !confirmingDiscard) {
      setConfirmingDiscard(true)
      return
    }
    setConfirmingDiscard(false)
    setDraft(draftFromRecord(record))
    if (props.initialEditing === true && props.onCancelEdit !== undefined) {
      props.onCancelEdit()
    } else {
      setEditing(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    setActionError('')
    setConfirmingDiscard(false)
    try {
      await props.onSave?.(draft)
      setConflict(false)
      setEditing(false)
    } catch (error) {
      if (isConflict(error)) setConflict(true)
      else setSaveError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    setConfirmingArchive(false)
    setActionError('')
    try {
      await props.onDelete?.()
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const restore = async (): Promise<void> => {
    setActionError('')
    try {
      await props.onRestore?.()
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const reloadRecord = async (): Promise<void> => {
    setReloading(true)
    setSaveError('')
    try {
      await props.onReload?.()
      setConflict(false)
      setConfirmingDiscard(false)
      setEditing(false)
    } catch (error) {
      setSaveError(errorText(error))
    } finally {
      setReloading(false)
    }
  }

  const wrap = (body: React.ReactNode, footer: React.ReactNode): React.ReactElement => {
    if (props.inModal === true) {
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dsh-mem-modal-body' }, body),
        h('div', { className: 'dsh-mem-modal-footer' }, footer),
      )
    }
    return h(
      'div',
      { className: 'dsh-mem-detail' },
      body,
      h('div', { className: 'dsh-mem-actions', style: { marginTop: '2px' } }, footer),
    )
  }

  if (editing) {
    const editBody = h(
      'div',
      { className: 'dsh-mem-detail' },
      conflict
        ? h(
            'div',
            { className: 'dsh-mem-confirm', role: 'alert' },
            h('span', null, t('error.conflict')),
            h(
              Button,
              {
                size: 'sm',
                ...(reloading ? { disabled: true } : {}),
                onClick: () => {
                  void reloadRecord()
                },
              },
              t('detail.reload'),
            ),
          )
        : null,
      saveError === ''
        ? null
        : h('div', { className: 'dsh-mem-confirm', role: 'alert' }, saveError),
      confirmingDiscard
        ? h(
            'div',
            { className: 'dsh-mem-confirm', role: 'alert' },
            h('span', null, t('detail.dirtyClose')),
            h(
              Button,
              {
                variant: 'danger',
                size: 'sm',
                onClick: () => {
                  setConfirmingDiscard(false)
                  setDraft(draftFromRecord(record))
                  if (props.initialEditing === true && props.onCancelEdit !== undefined) {
                    props.onCancelEdit()
                  } else {
                    setEditing(false)
                  }
                },
              },
              t('detail.discardChanges'),
            ),
            h(
              Button,
              { variant: 'ghost', size: 'sm', onClick: () => setConfirmingDiscard(false) },
              t('detail.keepEditing'),
            ),
          )
        : null,
      h(MemoryEditor, {
        key: draft.id,
        draft,
        hideActions: true,
        onChange: (patch) => {
          setConfirmingDiscard(false)
          setDraft((current) => ({ ...current, ...patch }))
        },
        onSave: () => {
          void save()
        },
        onCancel: cancelEdit,
        saving,
      }),
    )

    const editFooter = h(
      React.Fragment,
      null,
      h(
        Button,
        { variant: 'ghost', ...(saving ? { disabled: true } : {}), onClick: cancelEdit },
        t('common.cancel'),
      ),
      h(
        Button,
        {
          variant: 'primary',
          ...(saving ? { disabled: true } : {}),
          onClick: () => {
            void save()
          },
        },
        saving ? t('common.saving') : (props.saveLabel ?? t('common.save')),
      ),
    )

    return wrap(editBody, editFooter)
  }

  const sourceList = props.sources ?? record.sourceRefs
  const readBody = h(
    'div',
    { className: 'dsh-mem-detail' },
    h(
      'div',
      { className: 'dsh-mem-detail-head' },
      props.inModal === true ? null : h('h3', { className: 'dsh-mem-detail-title' }, record.title),
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
        h(Tag, null, record.scope.kind === 'global' ? t('scope.global') : t('scope.workspace')),
        record.pinned ? h(Tag, { tone: 'warn' }, t('detail.pinned')) : null,
      ),
    ),
    h(
      'div',
      { className: 'dsh-mem-body-box' },
      h(
        'div',
        { className: 'dsh-mem-body-tools' },
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            onClick: () => {
              void copyText(record.body).then((ok) => {
                if (ok) flashCopied('body')
              })
            },
          },
          copiedKey === 'body' ? t('common.copied') : t('common.copy'),
        ),
      ),
      h('div', { className: 'dsh-mem-body' }, record.body),
    ),
    h(
      'dl',
      { className: 'dsh-mem-facts' },
      ...facts(record).map((fact) =>
        h(
          'div',
          { key: fact.label, className: 'dsh-mem-fact' },
          h('dt', null, fact.label),
          h('dd', null, fact.value),
        ),
      ),
    ),
    record.tags.length === 0
      ? null
      : h(
          'div',
          { className: 'dsh-mem-detail-tags' },
          h('span', { className: 'dsh-mem-count' }, `${t('detail.tags')}:`),
          ...record.tags.map((tag) => h(Tag, { key: tag, tone: 'accent' }, tag)),
        ),
    sourceList.length === 0
      ? null
      : h(
          'div',
          { className: 'dsh-mem-detail-tags' },
          h('span', { className: 'dsh-mem-count' }, `${t('detail.sources')}:`),
          ...sourceList.map((source, index) => {
            const key = `${source.sessionId}-${index}`
            return h(
              'button',
              {
                key,
                type: 'button',
                className: 'dsh-mem-source-btn',
                title: source.sessionId,
                onClick: () => {
                  void copyText(source.sessionId).then((ok) => {
                    if (ok) flashCopied(key)
                  })
                },
              },
              copiedKey === key ? t('common.copied') : shortId(source.sessionId),
            )
          }),
        ),
    actionError === ''
      ? null
      : h('div', { className: 'dsh-mem-confirm', role: 'alert' }, actionError),
    confirmingArchive && record.status !== 'archived'
      ? h(
          'div',
          { className: 'dsh-mem-confirm', role: 'alert' },
          h('span', null, t('detail.archiveHint')),
          h(
            Button,
            { variant: 'danger', size: 'sm', onClick: () => void remove() },
            t('common.confirm'),
          ),
          h(
            Button,
            { variant: 'ghost', size: 'sm', onClick: () => setConfirmingArchive(false) },
            t('common.cancel'),
          ),
        )
      : null,
  )

  const readFooter = h(
    'div',
    { className: 'dsh-mem-footer-split' },
    h(
      'div',
      { className: 'dsh-mem-actions' },
      confirmingArchive || record.status === 'archived'
        ? null
        : h(
            Button,
            {
              variant: 'danger',
              ...(props.deleting === true ? { disabled: true } : {}),
              onClick: () => setConfirmingArchive(true),
            },
            t('detail.archive'),
          ),
    ),
    h(
      'div',
      { className: 'dsh-mem-actions' },
      record.status !== 'archived'
        ? h(Button, { variant: 'primary', onClick: beginEdit }, t('common.edit'))
        : h(
            Button,
            {
              variant: 'primary',
              ...(props.restoring === true ? { disabled: true } : {}),
              onClick: () => {
                void restore()
              },
            },
            t('common.restore'),
          ),
    ),
  )

  return wrap(readBody, readFooter)
}
