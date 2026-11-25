/**
 * Create dialog for one new memory.
 *
 * Global scope is only legal for preferences, so choosing the global layer
 * switches the type instead of letting the Host reject the write.
 * @module memloom/client/MemoryCreate
 */
import * as React from 'react'
import type { MemoryCreateInput, MemoryType } from './context.ts'
import { errorText } from './errors.ts'
import { t } from './locales.ts'
import { Button, ImportanceField, Select, TagsInput, TextField } from './ui.tsx'

const h = React.createElement

/** Props accepted by {@link MemoryCreate}. */
export interface MemoryCreateProps {
  workspaceKey?: string
  workspaceRoot?: string
  onSave: (input: MemoryCreateInput) => Promise<void>
  onCancel: () => void
  /** Report whether the form holds unsaved input, so closing can confirm. */
  onDirtyChange?: (dirty: boolean) => void
  /** Render inside a Modal with a scrollable body and pinned footer. */
  inModal?: boolean
}

const TYPES: MemoryType[] = ['lesson', 'worklog', 'wiki', 'preference']

/**
 * Render the new-memory form.
 * @param props - Target workspace plus save/cancel callbacks.
 * @returns The form element.
 */
export function MemoryCreate(props: MemoryCreateProps): React.ReactElement {
  const [type, setType] = React.useState<MemoryType>('lesson')
  const [scope, setScope] = React.useState<'workspace' | 'global'>('workspace')
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')
  const [tags, setTags] = React.useState<string[]>([])
  const [importance, setImportance] = React.useState(0.5)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  const effectiveType: MemoryType = scope === 'global' ? 'preference' : type
  const canSave = title.trim() !== '' && body.trim() !== '' && !saving
  const dirty = title.trim() !== '' || body.trim() !== '' || tags.length > 0

  React.useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty, props.onDirtyChange])

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      await props.onSave({
        type: effectiveType,
        title: title.trim(),
        body,
        scope,
        ...(scope === 'workspace' && props.workspaceKey !== undefined
          ? { workspaceKey: props.workspaceKey }
          : {}),
        ...(scope === 'workspace' && props.workspaceRoot !== undefined
          ? { workspaceRoot: props.workspaceRoot }
          : {}),
        tags,
        importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
      })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const fields = h(
    'div',
    { className: 'dsh-mem-detail' },
    h(
      'div',
      { className: 'dsh-mem-form-grid' },
      h(
        'div',
        { className: 'dsh-mem-field' },
        h('span', { className: 'dsh-mem-label' }, t('create.scope')),
        h(Select, {
          label: t('create.scope'),
          value: scope,
          disabled: saving,
          options: [
            { value: 'workspace', label: t('scope.workspace') },
            { value: 'global', label: t('scope.global') },
          ],
          onChange: (value) => setScope(value === 'global' ? 'global' : 'workspace'),
        }),
      ),
      h(
        'div',
        { className: 'dsh-mem-field' },
        h('span', { className: 'dsh-mem-label' }, t('create.type')),
        scope === 'global'
          ? h(
              'p',
              { className: 'dsh-mem-hint', style: { paddingTop: '6px' } },
              t('create.globalHint'),
            )
          : h(Select, {
              label: t('create.type'),
              value: type,
              disabled: saving,
              options: TYPES.map((value) => ({ value, label: t(`type.${value}`) })),
              onChange: (value) => {
                const next = TYPES.find((candidate) => candidate === value)
                if (next !== undefined) setType(next)
              },
            }),
      ),
    ),
    h(TextField, {
      label: t('create.titleField'),
      value: title,
      disabled: saving,
      onChange: setTitle,
    }),
    h(TextField, {
      label: t('create.bodyField'),
      value: body,
      multiline: true,
      disabled: saving,
      onChange: setBody,
    }),
    h(TagsInput, {
      label: t('create.tagsField'),
      hint: t('create.tagsHint'),
      placeholder: t('detail.tagsPlaceholder'),
      value: tags,
      disabled: saving,
      onChange: setTags,
    }),
    h(ImportanceField, {
      label: t('create.importance'),
      value: importance,
      disabled: saving,
      onChange: setImportance,
    }),
    error === '' ? null : h('div', { className: 'dsh-mem-confirm', role: 'alert' }, error),
  )

  const footer = h(
    React.Fragment,
    null,
    h(
      Button,
      { variant: 'ghost', ...(saving ? { disabled: true } : {}), onClick: props.onCancel },
      t('common.cancel'),
    ),
    h(
      Button,
      {
        variant: 'primary',
        ...(canSave ? {} : { disabled: true }),
        onClick: () => {
          void submit()
        },
      },
      saving ? t('common.saving') : t('create.submit'),
    ),
  )

  if (props.inModal === true) {
    return h(
      React.Fragment,
      null,
      h('div', { className: 'dsh-mem-modal-body' }, fields),
      h('div', { className: 'dsh-mem-modal-footer' }, footer),
    )
  }

  return h(
    'div',
    { className: 'dsh-mem-detail' },
    fields,
    h('div', { className: 'dsh-mem-actions', style: { marginTop: '4px' } }, footer),
  )
}
