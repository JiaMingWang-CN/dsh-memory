/**
 * In-app Update & Cross-Host Plugin Sync Modal for Memloom Desktop.
 * @module memloom/desktop/renderer/UpdateModal
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import type { DesktopAppInfo, DesktopBridgeApi } from '../ipc-contract.ts'
import type { UpdateCheckResult, UpdaterTaskSnapshot } from '../updater.ts'
import { desktopErrorText, unwrapIpc } from './desktop-locales.ts'
import { Button, Icons, Modal, type ToastEntry } from './ui.tsx'

const h = React.createElement

export interface UpdateModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly bridge: DesktopBridgeApi
  readonly appInfo?: DesktopAppInfo
  readonly checkResult?: UpdateCheckResult
  readonly taskState?: UpdaterTaskSnapshot
  readonly onChecked: (result: UpdateCheckResult) => void
  readonly onStateChange: (state: UpdaterTaskSnapshot) => void
  readonly onNotify: (message: string, tone?: ToastEntry['tone']) => void
}

function isActivePhase(phase: UpdaterTaskSnapshot['phase'] | undefined): boolean {
  return (
    phase === 'checking' ||
    phase === 'downloading' ||
    phase === 'verifying' ||
    phase === 'launching-installer' ||
    phase === 'syncing-plugins'
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function UpdateModal(props: UpdateModalProps): React.ReactElement | null {
  const {
    open,
    onClose,
    bridge,
    appInfo,
    checkResult,
    taskState,
    onChecked,
    onStateChange,
    onNotify,
  } = props
  const [checking, setChecking] = React.useState(false)
  const [errorMsg, setErrorMsg] = React.useState('')

  const runCheck = React.useCallback(async (): Promise<void> => {
    setChecking(true)
    setErrorMsg('')
    try {
      const result = unwrapIpc(await bridge.updater.check())
      onChecked(result)
    } catch (err) {
      setErrorMsg(desktopErrorText(err))
    } finally {
      setChecking(false)
    }
  }, [bridge, onChecked])

  React.useEffect(() => {
    if (open && checkResult === undefined && !checking) {
      void runCheck()
    }
  }, [open, checkResult, checking, runCheck])

  if (!open) return null

  const active = isActivePhase(taskState?.phase)
  const runtimeMode = checkResult?.runtimeMode ?? appInfo?.runtimeMode ?? 'electron'
  const currentVersion = checkResult?.currentVersion ?? appInfo?.version ?? '0.0.0'
  const progressPct =
    taskState?.bytesReceived !== undefined &&
    taskState.totalBytes !== undefined &&
    taskState.totalBytes > 0
      ? Math.min(100, Math.round((taskState.bytesReceived / taskState.totalBytes) * 100))
      : undefined

  const handleStartAppUpdate = async (): Promise<void> => {
    setErrorMsg('')
    try {
      const next = unwrapIpc(await bridge.updater.startAppUpdate())
      onStateChange(next)
    } catch (err) {
      const msg = desktopErrorText(err)
      setErrorMsg(msg)
      onNotify(msg, 'danger')
    }
  }

  const handleUpdatePluginsOnline = async (): Promise<void> => {
    setErrorMsg('')
    try {
      const next = unwrapIpc(await bridge.updater.updateInstalledPluginsOnline())
      onStateChange(next)
    } catch (err) {
      const msg = desktopErrorText(err)
      setErrorMsg(msg)
      onNotify(msg, 'danger')
    }
  }

  const handleCancel = async (): Promise<void> => {
    try {
      const next = unwrapIpc(await bridge.updater.cancel())
      onStateChange(next)
    } catch (err) {
      onNotify(desktopErrorText(err), 'danger')
    }
  }

  const handleOpenRelease = async (): Promise<void> => {
    const url = checkResult?.releaseUrl ?? 'https://github.com/JiaMingWang-CN/memloom/releases'
    try {
      unwrapIpc(await bridge.app.openExternal({ url }))
    } catch (err) {
      onNotify(desktopErrorText(err), 'danger')
    }
  }

  return h(
    Modal,
    {
      title: t('desktop.updater.title'),
      closeLabel: t('common.close'),
      maxWidth: 560,
      onClose,
      footer: h(
        React.Fragment,
        null,
        h(
          Button,
          { size: 'sm', disabled: checking || active, onClick: () => void runCheck() },
          Icons.refresh(),
          h('span', null, t('desktop.updater.recheck')),
        ),
        active && taskState?.phase === 'downloading'
          ? h(
              Button,
              { size: 'sm', variant: 'danger', onClick: () => void handleCancel() },
              t('desktop.updater.cancelDownload'),
            )
          : null,
        h(
          Button,
          { size: 'sm', variant: 'ghost', onClick: () => void handleOpenRelease() },
          t('desktop.updater.openRelease'),
        ),
        runtimeMode === 'electron' && checkResult?.hasUpdate && checkResult.canSelfUpdateApp
          ? h(
              Button,
              {
                size: 'sm',
                variant: 'primary',
                disabled: active || checking,
                onClick: () => void handleStartAppUpdate(),
              },
              Icons.download(),
              h('span', null, t('desktop.updater.updateNow')),
            )
          : runtimeMode === 'local-bridge' && checkResult !== undefined
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'primary',
                  disabled: active || checking || checkResult.installedTargets.length === 0,
                  onClick: () => void handleUpdatePluginsOnline(),
                },
                Icons.download(),
                h('span', null, t('desktop.updater.updateOnlinePlugins')),
              )
            : null,
      ),
    },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
      // Version summary row
      h(
        'div',
        {
          className: 'ml-surface-card',
          style: {
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          },
        },
        h(
          'div',
          { style: { fontSize: '13px', color: 'var(--ml-text-secondary)' } },
          `${t('desktop.updater.currentVersion')}: `,
          h(
            'strong',
            { className: 'ml-mono', style: { color: 'var(--ml-text-primary)' } },
            `v${currentVersion}`,
          ),
        ),
        checkResult !== undefined
          ? h(
              'div',
              { style: { fontSize: '13px', color: 'var(--ml-text-secondary)' } },
              `${t('desktop.updater.latestVersion')}: `,
              h(
                'strong',
                {
                  className: 'ml-mono',
                  style: {
                    color: checkResult.hasUpdate ? 'var(--ml-copper)' : 'var(--ml-success)',
                  },
                },
                `v${checkResult.latestVersion}`,
              ),
            )
          : null,
      ),

      // Local-bridge hint
      runtimeMode === 'local-bridge'
        ? h(
            'div',
            {
              className: 'ml-banner',
              'data-tone': 'info',
              style: { margin: 0, borderRadius: '10px' },
            },
            h('span', null, t('desktop.updater.localBridgeHint')),
          )
        : null,

      // Status message or update available badge
      checkResult !== undefined
        ? h(
            'div',
            { style: { fontSize: '13px', fontWeight: 500, color: 'var(--ml-text-primary)' } },
            checkResult.hasUpdate
              ? formatMessage('desktop.updater.updateAvailable', {
                  version: checkResult.latestVersion,
                })
              : t('desktop.updater.upToDate'),
          )
        : null,

      // Installed targets list
      checkResult !== undefined
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h(
              'div',
              { style: { fontSize: '12px', fontWeight: 600, color: 'var(--ml-text-muted)' } },
              t('desktop.updater.syncTargetsTitle'),
            ),
            checkResult.installedTargets.length === 0
              ? h(
                  'div',
                  { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                  t('desktop.updater.noInstalledTargets'),
                )
              : h(
                  'div',
                  { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                  ...checkResult.installedTargets.map((target, idx) =>
                    h(
                      'span',
                      {
                        key: `${target.kind}-${target.profileName ?? idx}`,
                        className: 'ml-host-tag',
                        style: {
                          background: 'var(--ml-recessed)',
                          color: 'var(--ml-text-primary)',
                        },
                      },
                      target.kind === 'agy'
                        ? `AGY${target.previousVersion !== undefined ? ` (v${target.previousVersion})` : ''}`
                        : `DSH (${target.profileName ?? 'desktop'})${target.previousVersion !== undefined ? ` v${target.previousVersion}` : ''}`,
                    ),
                  ),
                ),
          )
        : null,

      // Active task progress bar
      active && taskState !== undefined
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  color: 'var(--ml-text-secondary)',
                },
              },
              h('span', null, taskState.message ?? taskState.phase),
              taskState.bytesReceived !== undefined
                ? h(
                    'span',
                    { className: 'ml-mono' },
                    taskState.totalBytes !== undefined
                      ? `${formatBytes(taskState.bytesReceived)} / ${formatBytes(taskState.totalBytes)} (${progressPct ?? 0}%)`
                      : formatBytes(taskState.bytesReceived),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ml-progress-track' },
              h('div', {
                className: 'ml-progress-fill',
                style: { width: `${progressPct ?? 100}%` },
              }),
            ),
          )
        : null,

      // Task failure / error message
      errorMsg !== '' || (taskState?.phase === 'failed' && taskState.errorMessage !== undefined)
        ? h(
            'div',
            {
              role: 'alert',
              style: {
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--ml-danger-soft)',
                color: 'var(--ml-danger)',
                fontSize: '12px',
                lineHeight: 1.5,
              },
            },
            errorMsg !== '' ? errorMsg : (taskState?.errorMessage ?? ''),
          )
        : null,

      // Release notes
      checkResult !== undefined && checkResult.releaseNotes.trim() !== ''
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h(
              'div',
              { style: { fontSize: '12px', fontWeight: 600, color: 'var(--ml-text-muted)' } },
              t('desktop.updater.releaseNotes'),
            ),
            h(
              'pre',
              {
                className: 'ml-scroll',
                style: {
                  margin: 0,
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'var(--ml-panel-bg)',
                  border: '1px solid var(--ml-border)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  maxHeight: '160px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                  color: 'var(--ml-text-secondary)',
                },
              },
              checkResult.releaseNotes,
            ),
          )
        : null,
    ),
  )
}
