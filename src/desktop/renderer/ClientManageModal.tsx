/**
 * Modal for adding a custom memory store or editing/removing a registered client.
 * @module memloom/desktop/renderer/ClientManageModal
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import { Button, Modal, Switch, Tag, TextField } from '../../client/ui.tsx'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type { DesktopClientInfo } from '../multi-service.ts'
import { desktopErrorText, unwrapIpc } from './desktop-locales.ts'

const h = React.createElement
const Fragment = React.Fragment

export interface ClientManageModalProps {
  readonly bridge: DesktopBridgeApi
  /** Present when editing an existing client; omitted when adding a custom store. */
  readonly client?: DesktopClientInfo
  readonly onClose: () => void
  readonly onSaved: (clientId?: string) => void | Promise<void>
}

/** Add or manage one registered desktop client. */
export function ClientManageModal(props: ClientManageModalProps): React.ReactElement {
  const isEdit = props.client !== undefined
  const [name, setName] = React.useState(props.client?.name ?? '')
  const [storePath, setStorePath] = React.useState(props.client?.storePath ?? '')
  const [createIfMissing, setCreateIfMissing] = React.useState(false)
  const [dshProtected, setDshProtected] = React.useState(props.client?.dshProtected ?? false)
  const [enabled, setEnabled] = React.useState(props.client?.enabled ?? true)
  const [busy, setBusy] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [error, setError] = React.useState('')

  const pickFile = async (mode: 'open' | 'create'): Promise<void> => {
    setError('')
    try {
      const picked = unwrapIpc(await props.bridge.dialog.pickMemoryFile({ mode }))
      if (picked !== null && picked !== '') {
        setStorePath(picked)
        if (mode === 'create') {
          setCreateIfMissing(true)
        }
      }
    } catch (reason) {
      setError(desktopErrorText(reason))
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (isEdit && props.client !== undefined) {
        const updated = unwrapIpc(
          await props.bridge.clients.update({
            id: props.client.id,
            name: name.trim(),
            enabled,
            ...(props.client.kind !== 'dsh' ? { dshProtected } : {}),
          }),
        )
        await props.onSaved(updated.id)
      } else {
        const created = unwrapIpc(
          await props.bridge.clients.add({
            name: name.trim(),
            storePath: storePath.trim(),
            dshProtected,
            createIfMissing,
          }),
        )
        await props.onSaved(created.id)
      }
    } catch (reason) {
      setError(desktopErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const removeClient = async (): Promise<void> => {
    if (props.client === undefined || props.client.builtin) return
    setBusy(true)
    setError('')
    try {
      unwrapIpc(await props.bridge.clients.remove({ id: props.client.id }))
      await props.onSaved(undefined)
    } catch (reason) {
      setError(desktopErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = isEdit
    ? name.trim() !== '' && !busy
    : name.trim() !== '' && storePath.trim() !== '' && !busy

  const title = isEdit
    ? formatMessage('desktop.clientModal.editTitle', { name: props.client!.name })
    : t('desktop.clientModal.addTitle')

  const footer = h(
    'div',
    { className: 'dsh-mem-footer-split' },
    h(
      'div',
      { className: 'dsh-mem-actions' },
      isEdit && props.client !== undefined && !props.client.builtin && !confirmRemove
        ? h(
            Button,
            {
              variant: 'danger',
              size: 'sm',
              disabled: busy,
              onClick: () => setConfirmRemove(true),
            },
            t('desktop.clientModal.remove'),
          )
        : null,
    ),
    h(
      'div',
      { className: 'dsh-mem-actions' },
      h(Button, { variant: 'ghost', disabled: busy, onClick: props.onClose }, t('common.cancel')),
      h(
        Button,
        {
          variant: 'primary',
          disabled: !canSubmit,
          onClick: () => {
            void submit()
          },
        },
        busy ? t('common.saving') : isEdit ? t('common.save') : t('desktop.clientModal.addSubmit'),
      ),
    ),
  )

  return h(
    Modal,
    {
      title,
      onClose: props.onClose,
      closeLabel: t('common.close'),
      footer,
    },
    h(
      'div',
      { className: 'dsh-mem-detail' },
      h(TextField, {
        label: t('desktop.clientModal.name'),
        value: name,
        disabled: busy,
        onChange: setName,
      }),
      isEdit && props.client !== undefined
        ? h(
            'div',
            { className: 'dsh-mem-field' },
            h('span', { className: 'dsh-mem-label' }, t('desktop.clientModal.storePath')),
            h('span', { className: 'memloom-meta-path' }, props.client.storePath),
            props.client.builtin
              ? h(
                  'span',
                  { className: 'dsh-mem-hint' },
                  t('desktop.clientModal.builtinReadonlyPath'),
                )
              : null,
            h(
              'div',
              { className: 'dsh-mem-detail-tags' },
              h(Tag, null, `${t('desktop.clientModal.health')}: ${props.client.health}`),
              props.client.format !== null
                ? h(Tag, null, `${t('desktop.clientModal.format')}: ${props.client.format}`)
                : null,
            ),
          )
        : h(
            Fragment,
            null,
            h(TextField, {
              label: t('desktop.clientModal.storePath'),
              value: storePath,
              disabled: busy,
              onChange: setStorePath,
            }),
            h(
              'div',
              { className: 'dsh-mem-actions' },
              h(
                Button,
                {
                  size: 'sm',
                  disabled: busy,
                  onClick: () => {
                    void pickFile('open')
                  },
                },
                t('desktop.clientModal.pickExisting'),
              ),
              h(
                Button,
                {
                  size: 'sm',
                  disabled: busy,
                  onClick: () => {
                    void pickFile('create')
                  },
                },
                t('desktop.clientModal.pickNew'),
              ),
            ),
            h(Switch, {
              label: t('desktop.clientModal.createIfMissing'),
              checked: createIfMissing,
              disabled: busy,
              onChange: setCreateIfMissing,
            }),
          ),
      isEdit
        ? h(Switch, {
            label: t('desktop.clientModal.enabled'),
            checked: enabled,
            disabled: busy,
            onChange: setEnabled,
          })
        : null,
      h(Switch, {
        label: t('desktop.clientModal.dshProtected'),
        hint: t('desktop.clientModal.dshProtectedHint'),
        checked: dshProtected,
        disabled: busy || (isEdit && props.client?.kind === 'dsh'),
        onChange: setDshProtected,
      }),
      confirmRemove
        ? h(
            'div',
            { className: 'dsh-mem-confirm', role: 'alert' },
            h('span', null, t('desktop.clientModal.removeConfirm')),
            h(
              Button,
              {
                variant: 'danger',
                size: 'sm',
                disabled: busy,
                onClick: () => {
                  void removeClient()
                },
              },
              t('common.confirm'),
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                disabled: busy,
                onClick: () => setConfirmRemove(false),
              },
              t('common.cancel'),
            ),
          )
        : null,
      error === '' ? null : h('div', { className: 'dsh-mem-confirm', role: 'alert' }, error),
    ),
  )
}
