/**
 * Controlled editor for one memory draft.
 *
 * The section owns the draft object; this component only renders fields and
 * reports changes. Nothing is persisted until the user presses Save, which the
 * parent routes through `ctx.remote.memory.update` with the original
 * `contentRevision` for optimistic concurrency.
 * @module memloom/client/MemoryEditor
 */
import * as React from 'react'
import type { MemoryRecord, MemoryStatus, MemoryType } from './context.ts'
import { t } from './locales.ts'
import { Button, ImportanceField, Switch, TagsInput, TextField } from './ui.tsx'

const h = React.createElement

/** Editable projection of one memory used while the user edits it. */
export interface MemoryDraft {
  id: string
  expectedContentRevision: number
  type: MemoryType
  title: string
  body: string
  tags: string[]
  importance: number
  pinned: boolean
  status: MemoryStatus
}

/** Props accepted by {@link MemoryEditor}. */
export interface MemoryEditorProps {
  draft: MemoryDraft
  onChange: (patch: Partial<MemoryDraft>) => void
  onSave: () => void
  onCancel: () => void
  saving?: boolean
  /** Hide built-in action buttons when the parent renders a fixed modal footer. */
  hideActions?: boolean
  /** Override the primary button label (e.g. "Save & accept" during proposal review). */
  saveLabel?: string
}

/**
 * Build a draft from a stored record.
 * @param record - Source record.
 * @returns A detached editable draft.
 */
export function draftFromRecord(record: MemoryRecord): MemoryDraft {
  return {
    id: record.id,
    expectedContentRevision: record.contentRevision,
    type: record.type,
    title: record.title,
    body: record.body,
    tags: [...record.tags],
    importance: record.importance,
    pinned: record.pinned,
    status: record.status,
  }
}

/**
 * Render the editor fields.
 * @param props - Controlled draft and callbacks.
 * @returns The editor element.
 */
export function MemoryEditor(props: MemoryEditorProps): React.ReactElement {
  const { draft, onChange } = props
  const busy = props.saving === true
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
    h(TextField, {
      label: t('detail.title'),
      value: draft.title,
      disabled: busy,
      onChange: (value: string) => onChange({ title: value }),
    }),
    h(TextField, {
      label: t('detail.body'),
      value: draft.body,
      multiline: true,
      disabled: busy,
      onChange: (value: string) => onChange({ body: value }),
    }),
    h(TagsInput, {
      label: t('detail.tags'),
      hint: t('detail.tagsHint'),
      placeholder: t('detail.tagsPlaceholder'),
      value: draft.tags,
      disabled: busy,
      onChange: (tags: string[]) => onChange({ tags }),
    }),
    h(ImportanceField, {
      id: 'dsh-mem-importance',
      label: t('detail.importance'),
      value: draft.importance,
      disabled: busy,
      onChange: (importance: number) => onChange({ importance }),
    }),
    h(Switch, {
      label: t('detail.pinned'),
      checked: draft.pinned,
      disabled: busy,
      onChange: (checked: boolean) => onChange({ pinned: checked }),
    }),
    props.hideActions === true
      ? null
      : h(
          'div',
          { className: 'dsh-mem-actions', style: { marginTop: '12px' } },
          h(
            Button,
            {
              variant: 'primary',
              ...(busy ? { disabled: true } : {}),
              onClick: props.onSave,
            },
            busy ? t('common.saving') : (props.saveLabel ?? t('common.save')),
          ),
          h(
            Button,
            { variant: 'ghost', ...(busy ? { disabled: true } : {}), onClick: props.onCancel },
            t('common.cancel'),
          ),
        ),
  )
}
