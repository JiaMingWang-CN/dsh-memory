/**
 * Host Configuration & Safety Guard workbench:
 * - AGY hosts expose all 24 `AGY_EDITABLE_CONFIG_FIELDS` with detented byte slider,
 *   precision steppers, subagent model selector, safety risk confirmation, floating unsaved bar, and backup/rebuild tools.
 * - DSH hosts expose interactive WriteGuard state machine, snapshot policy, and read-only profile card.
 * @module memloom/desktop/renderer/DesktopConfigPanel
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import {
  AGY_EDITABLE_CONFIG_FIELDS,
  MEMORY_CONFIG_DEFAULTS,
  type DreamSubagentModel,
  type MemoryConfig,
  type ResolvedMemoryConfig,
} from '../../core/config.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type { DesktopClientConfigResult, DesktopClientInfo } from '../multi-service.ts'
import type { WriteGuardSnapshot } from '../write-guard.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'
import {
  Button,
  DetentedSlider,
  Dropdown,
  EmptyBlock,
  HostLogo,
  Icons,
  Modal,
  NumericStepper,
  SegmentedControl,
  Switch,
} from './ui.tsx'

const h = React.createElement
const MS_PER_SECOND = 1_000

export interface DesktopConfigPanelProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly guardSnapshot?: WriteGuardSnapshot
  readonly refreshToken: number
  readonly banners?: React.ReactNode
  readonly onRecheckGuard: () => Promise<void>
  readonly onRequestUnlockDsh: () => void
  readonly onRelockDsh: () => Promise<void>
  readonly onDataChanged: () => Promise<void>
  readonly onExternalChange: () => void
  readonly onNotify: (message: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void
}

interface AgyConfigDraft {
  enabled: boolean
  indexMaxBytes: number
  autoCaptureEpisodes: boolean
  autoDream: boolean
  autoAcceptProposals: boolean
  dreamIdleDelaySec: number
  autoDreamMinIntervalSec: number
  dreamSubagentModel: DreamSubagentModel
  dreamMaxEpisodes: number
  dreamLookbackDays: number
  dreamProcessingTimeoutMs: number
  refreshIndexOnChange: boolean
  refreshMinIntervalMs: number
  refreshMaxBytes: number
  refreshResetBytes: number
  worklogCapture: 'significant' | 'off'
  worklogRetentionDays: number
  episodeRetentionDays: number
  archivePurgePolicy: 'manual' | 'after-export' | 'age'
  archiveRetentionDays: number
  rebuildLookbackDays: number
  injectForSubagents: boolean
  redactSecrets: boolean
  searchLimit: number
}

function draftFromResolved(config?: ResolvedMemoryConfig): AgyConfigDraft {
  const c = config ?? MEMORY_CONFIG_DEFAULTS
  return {
    enabled: c.enabled,
    indexMaxBytes: c.indexMaxBytes,
    autoCaptureEpisodes: c.autoCaptureEpisodes,
    autoDream: c.autoDream,
    autoAcceptProposals: c.autoAcceptProposals,
    dreamIdleDelaySec: Math.max(0, Math.round(c.dreamIdleDelayMs / MS_PER_SECOND)),
    autoDreamMinIntervalSec: Math.max(0, Math.round(c.autoDreamMinIntervalMs / MS_PER_SECOND)),
    dreamSubagentModel: c.dreamSubagentModel,
    dreamMaxEpisodes: c.dreamMaxEpisodes,
    dreamLookbackDays: c.dreamLookbackDays,
    dreamProcessingTimeoutMs: c.dreamProcessingTimeoutMs,
    refreshIndexOnChange: c.refreshIndexOnChange,
    refreshMinIntervalMs: c.refreshMinIntervalMs,
    refreshMaxBytes: c.refreshMaxBytes,
    refreshResetBytes: c.refreshResetBytes,
    worklogCapture: c.worklogCapture,
    worklogRetentionDays: c.worklogRetentionDays,
    episodeRetentionDays: c.episodeRetentionDays,
    archivePurgePolicy: c.archivePurgePolicy,
    archiveRetentionDays: c.archiveRetentionDays,
    rebuildLookbackDays: c.rebuildLookbackDays,
    injectForSubagents: c.injectForSubagents,
    redactSecrets: c.redactSecrets,
    searchLimit: c.searchLimit,
  }
}

function countDiffs(a: AgyConfigDraft, b: AgyConfigDraft): number {
  let count = 0
  for (const k of Object.keys(a) as Array<keyof AgyConfigDraft>) {
    if (a[k] !== b[k]) count += 1
  }
  return count
}

function SettingRow(props: {
  readonly label: string
  readonly hint?: string
  readonly dim?: boolean
  readonly control: React.ReactNode
}): React.ReactElement {
  return h(
    'div',
    { className: 'ml-switch-row', ...(props.dim === true ? { 'data-dim': 'true' } : {}) },
    h(
      'div',
      { className: 'ml-switch-text' },
      h('span', { className: 'ml-switch-label' }, props.label),
      props.hint !== undefined && props.hint !== ''
        ? h('span', { className: 'ml-switch-hint' }, props.hint)
        : null,
    ),
    props.control,
  )
}

export function DesktopConfigPanel(props: DesktopConfigPanelProps): React.ReactElement {
  const { bridge, clients, guardSnapshot, refreshToken } = props
  const [hostId, setHostId] = React.useState<string>(
    () => clients.find((c) => c.kind === 'agy')?.id ?? clients[0]?.id ?? '',
  )
  const [configResult, setConfigResult] = React.useState<DesktopClientConfigResult | undefined>(
    undefined,
  )
  const [loading, setLoading] = React.useState(true)
  const [draft, setDraft] = React.useState<AgyConfigDraft>(() => draftFromResolved())
  const [saving, setSaving] = React.useState(false)
  const [riskWarnings, setRiskWarnings] = React.useState<string[]>([])
  const [maintModal, setMaintModal] = React.useState<'rebuild' | 'purge' | undefined>(undefined)

  React.useEffect(() => {
    if (hostId === '' || !clients.some((c) => c.id === hostId)) {
      const fallback = clients.find((c) => c.kind === 'agy')?.id ?? clients[0]?.id ?? ''
      if (fallback !== '') setHostId(fallback)
    }
  }, [hostId, clients])

  const activeClient = clients.find((c) => c.id === hostId)
  const draftRef = React.useRef(draft)
  draftRef.current = draft
  const loadedHostIdRef = React.useRef<string | undefined>(undefined)
  const loadedBaselineRef = React.useRef<AgyConfigDraft>(draftFromResolved())

  React.useEffect(() => {
    if (activeClient === undefined) {
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setRiskWarnings([])
    void bridge.memory
      .getConfig({ clientId: activeClient.id })
      .then((res) => {
        if (cancelled) return
        const val = unwrapIpc(res)
        const nextBaseline = draftFromResolved(val.config)
        const sameHost = loadedHostIdRef.current === activeClient.id
        const hasDirtyDraft =
          sameHost && countDiffs(draftRef.current, loadedBaselineRef.current) > 0
        loadedHostIdRef.current = activeClient.id
        loadedBaselineRef.current = nextBaseline
        setConfigResult(val)
        if (!hasDirtyDraft) {
          setDraft(nextBaseline)
        }
      })
      .catch(() => {
        if (!cancelled) setConfigResult(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [bridge, activeClient, refreshToken])

  const baseline = React.useMemo(() => draftFromResolved(configResult?.config), [configResult])
  const dirtyCount = configResult?.editable === true ? countDiffs(draft, baseline) : 0

  const updateDraft = (patch: Partial<AgyConfigDraft>): void => {
    setRiskWarnings([])
    setDraft((cur) => ({ ...cur, ...patch }))
  }

  const saveAgyConfig = async (confirmed = false): Promise<void> => {
    if (activeClient === undefined || configResult?.editable !== true) return
    if (!confirmed) {
      const warnings: string[] = []
      if (baseline.redactSecrets && !draft.redactSecrets)
        warnings.push(t('config.confirmDisableRedact'))
      if (!baseline.autoAcceptProposals && draft.autoAcceptProposals)
        warnings.push(t('desktop.config.confirmAutoAccept'))
      if (!baseline.injectForSubagents && draft.injectForSubagents)
        warnings.push(t('desktop.config.confirmInjectSubagents'))
      if (warnings.length > 0) {
        setRiskWarnings(warnings)
        return
      }
    }

    setRiskWarnings([])
    setSaving(true)
    try {
      const editableSet = new Set<keyof MemoryConfig>(
        configResult.editableFields ?? AGY_EDITABLE_CONFIG_FIELDS,
      )
      const fullPatch: Partial<MemoryConfig> = {
        enabled: draft.enabled,
        indexMaxBytes: draft.indexMaxBytes,
        autoCaptureEpisodes: draft.autoCaptureEpisodes,
        autoDream: draft.autoDream,
        autoAcceptProposals: draft.autoAcceptProposals,
        dreamIdleDelayMs: draft.dreamIdleDelaySec * MS_PER_SECOND,
        autoDreamMinIntervalMs: draft.autoDreamMinIntervalSec * MS_PER_SECOND,
        dreamSubagentModel: draft.dreamSubagentModel,
        dreamMaxEpisodes: draft.dreamMaxEpisodes,
        dreamLookbackDays: draft.dreamLookbackDays,
        dreamProcessingTimeoutMs: draft.dreamProcessingTimeoutMs,
        refreshIndexOnChange: draft.refreshIndexOnChange,
        refreshMinIntervalMs: draft.refreshMinIntervalMs,
        refreshMaxBytes: draft.refreshMaxBytes,
        refreshResetBytes: draft.refreshResetBytes,
        worklogCapture: draft.worklogCapture,
        worklogRetentionDays: draft.worklogRetentionDays,
        episodeRetentionDays: draft.episodeRetentionDays,
        archivePurgePolicy: draft.archivePurgePolicy,
        archiveRetentionDays: draft.archiveRetentionDays,
        rebuildLookbackDays: draft.rebuildLookbackDays,
        injectForSubagents: draft.injectForSubagents,
        redactSecrets: draft.redactSecrets,
        searchLimit: draft.searchLimit,
      }
      const patch: Partial<MemoryConfig> = {}
      for (const field of AGY_EDITABLE_CONFIG_FIELDS) {
        if (editableSet.has(field)) {
          ;(patch as Record<string, unknown>)[field] = (fullPatch as Record<string, unknown>)[field]
        }
      }
      const next = unwrapIpc(await bridge.memory.updateConfig({ clientId: activeClient.id, patch }))
      setConfigResult(next)
      setDraft(draftFromResolved(next.config))
      if (patch.enabled !== undefined && patch.enabled !== baseline.enabled) {
        await props.onDataChanged()
      }
      props.onNotify(t('config.saved'), 'success')
    } catch (err) {
      props.onNotify(`${t('config.saveFailed')} ${desktopErrorText(err)}`, 'danger')
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    if (activeClient === undefined) return
    try {
      const exported = unwrapIpc(
        await bridge.memory.export({ clientId: activeClient.id, scope: 'all' }),
      )
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const savedPath = unwrapIpc(
        await bridge.dialog.saveExportJson({
          defaultFileName: `memloom-${activeClient.id}-${stamp}.json`,
          content: JSON.stringify(exported, null, 2),
        }),
      )
      if (savedPath !== null) {
        props.onNotify(
          formatMessage('desktop.transfer.exportSaved', { path: savedPath }),
          'success',
        )
      }
    } catch (err) {
      props.onNotify(desktopErrorText(err), 'danger')
    }
  }

  const handleImport = async (): Promise<void> => {
    if (activeClient === undefined || !activeClient.writable) return
    try {
      const picked = unwrapIpc(await bridge.dialog.pickImportJson())
      if (picked === null) return
      const payload = JSON.parse(picked.content)
      const report = unwrapIpc(
        await bridge.memory.import({
          clientId: activeClient.id,
          payload,
          options: { mode: 'merge', targetScope: 'all' },
        }),
      )
      await props.onDataChanged()
      props.onNotify(
        formatMessage('transfer.report', {
          created: report.created,
          skipped: report.skipped,
          replaced: report.replaced,
        }),
        'success',
      )
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    }
  }

  const handleConfirmMaintenance = async (): Promise<void> => {
    if (activeClient === undefined || maintModal === undefined) return
    setSaving(true)
    try {
      if (maintModal === 'rebuild') {
        unwrapIpc(
          await bridge.memory.rebuild({ clientId: activeClient.id, scope: 'all', confirm: true }),
        )
        props.onNotify(t('desktop.config.rebuildDone'), 'success')
      } else {
        unwrapIpc(
          await bridge.memory.purgeAll({
            clientId: activeClient.id,
            scope: 'all',
            confirmText: 'PURGE all',
          }),
        )
        props.onNotify(t('desktop.config.purgeDone'), 'warn')
      }
      setMaintModal(undefined)
      await props.onDataChanged()
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      props.onNotify(desktopErrorText(err), 'danger')
    } finally {
      setSaving(false)
    }
  }

  const isLockedDsh = guardSnapshot?.mode === 'readonly-dsh-running'

  return h(
    React.Fragment,
    null,
    h(
      'header',
      { className: 'ml-stage-header' },
      h(
        'div',
        { className: 'ml-stage-title-group' },
        h('h1', { className: 'ml-stage-title' }, t('desktop.nav.config')),
        clients.length > 0
          ? h(SegmentedControl<string>, {
              label: t('desktop.filter.hostPrefix'),
              role: 'tablist',
              value: hostId,
              onChange: setHostId,
              items: clients.map((c) => ({
                id: c.id,
                label: h(
                  'span',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                  h(HostLogo, { kind: c.kind, size: 14 }),
                  h('span', null, c.name),
                ),
              })),
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
        : activeClient === undefined
          ? h(EmptyBlock, { title: t('desktop.aggregate.noClients') })
          : h(
              'div',
              { className: 'ml-canvas-container', style: { paddingBottom: '68px' } },

              // Store path card
              h(
                'div',
                {
                  className: 'ml-surface-card',
                  style: {
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '16px',
                  },
                },
                h(
                  'div',
                  { style: { minWidth: 0 } },
                  h(
                    'div',
                    {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '13px',
                        fontWeight: 600,
                      },
                    },
                    h(HostLogo, { kind: activeClient.kind, size: 16 }),
                    h('span', null, activeClient.name),
                  ),
                  h(
                    'div',
                    {
                      className: 'ml-mono',
                      style: {
                        fontSize: '12px',
                        color: 'var(--ml-text-secondary)',
                        marginTop: '2px',
                        wordBreak: 'break-all',
                      },
                    },
                    activeClient.storePath,
                  ),
                  activeClient.pluginStatus !== undefined
                    ? h(
                        'div',
                        {
                          style: {
                            fontSize: '12px',
                            color: 'var(--ml-text-muted)',
                            marginTop: '6px',
                            lineHeight: 1.5,
                            wordBreak: 'break-all',
                          },
                        },
                        activeClient.pluginStatus.installPath !== undefined
                          ? `${t('desktop.plugin.installPathLabel')}: ${activeClient.pluginStatus.installPath}`
                          : activeClient.pluginStatus.state === 'not-installed'
                            ? activeClient.kind === 'dsh'
                              ? t('desktop.plugin.notInstalledHintDsh')
                              : t('desktop.plugin.notInstalledHintAgy')
                            : (activeClient.pluginStatus.detail ?? ''),
                        activeClient.pluginStatus.state === 'disabled' &&
                          activeClient.pluginStatus.installPath !== undefined &&
                          activeClient.pluginStatus.detail !== undefined
                          ? ` (${activeClient.pluginStatus.detail})`
                          : null,
                      )
                    : null,
                ),
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                      flex: 'none',
                    },
                  },
                  activeClient.pluginStatus !== undefined
                    ? h(
                        'span',
                        {
                          'data-plugin-state': activeClient.pluginStatus.state,
                          style: {
                            padding: '4px 10px',
                            borderRadius: '7px',
                            fontSize: '12px',
                            fontWeight: 500,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                            background:
                              activeClient.pluginStatus.state === 'enabled'
                                ? 'var(--ml-success-soft)'
                                : activeClient.pluginStatus.state === 'disabled'
                                  ? 'var(--ml-warn-soft)'
                                  : 'var(--ml-recessed)',
                            color:
                              activeClient.pluginStatus.state === 'enabled'
                                ? 'var(--ml-success)'
                                : activeClient.pluginStatus.state === 'disabled'
                                  ? 'var(--ml-warn)'
                                  : 'var(--ml-text-muted)',
                          },
                        },
                        h('span', {
                          className: 'ml-host-dot',
                          style: {
                            background:
                              activeClient.pluginStatus.state === 'enabled'
                                ? 'var(--ml-success)'
                                : activeClient.pluginStatus.state === 'disabled'
                                  ? 'var(--ml-warn)'
                                  : 'var(--ml-text-muted)',
                          },
                        }),
                        activeClient.pluginStatus.state === 'enabled'
                          ? `${t('desktop.plugin.enabled')}${activeClient.pluginStatus.version !== undefined ? ` v${activeClient.pluginStatus.version}` : ''}`
                          : activeClient.pluginStatus.state === 'disabled'
                            ? `${t('desktop.plugin.disabled')}${activeClient.pluginStatus.version !== undefined ? ` v${activeClient.pluginStatus.version}` : ''}`
                            : t('desktop.plugin.notInstalled'),
                      )
                    : null,
                  h(
                    'span',
                    {
                      style: {
                        padding: '4px 10px',
                        borderRadius: '7px',
                        fontSize: '12px',
                        fontWeight: 500,
                        flex: 'none',
                        background:
                          activeClient.kind === 'agy'
                            ? 'var(--ml-agy-soft)'
                            : activeClient.kind === 'dsh'
                              ? 'var(--ml-dsh-soft)'
                              : 'var(--ml-copper-soft)',
                        color:
                          activeClient.kind === 'agy'
                            ? 'var(--ml-agy)'
                            : activeClient.kind === 'dsh'
                              ? 'var(--ml-dsh)'
                              : 'var(--ml-copper)',
                      },
                    },
                    activeClient.kind === 'dsh'
                      ? t('desktop.config.dshStoreMeta')
                      : activeClient.kind === 'agy'
                        ? t('desktop.config.agyStoreMeta')
                        : activeClient.kind,
                  ),
                ),
              ),

              configResult === undefined || !configResult.editable
                ? h(
                    React.Fragment,
                    null,
                    // DSH Interactive WriteGuard Card
                    guardSnapshot !== undefined
                      ? h(
                          'div',
                          {
                            className: 'ml-surface-card',
                            style: {
                              padding: '20px',
                              boxShadow: `inset 0 0 0 1px ${isLockedDsh ? 'var(--ml-warn-border)' : 'var(--ml-border)'}`,
                            },
                          },
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
                              { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } },
                              h(
                                'div',
                                {
                                  style: {
                                    width: '38px',
                                    height: '38px',
                                    borderRadius: '10px',
                                    background: isLockedDsh
                                      ? 'var(--ml-warn-soft)'
                                      : 'var(--ml-success-soft)',
                                    color: isLockedDsh ? 'var(--ml-warn)' : 'var(--ml-success)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flex: 'none',
                                  },
                                },
                                isLockedDsh ? Icons.lock() : Icons.unlock(),
                              ),
                              h(
                                'div',
                                null,
                                h(
                                  'div',
                                  { style: { fontSize: '14px', fontWeight: 600 } },
                                  t('desktop.dshGuard.cardTitle'),
                                ),
                                h(
                                  'p',
                                  {
                                    style: {
                                      margin: '4px 0 0',
                                      fontSize: '12px',
                                      color: 'var(--ml-text-secondary)',
                                      lineHeight: 1.55,
                                    },
                                  },
                                  isLockedDsh
                                    ? formatMessage('desktop.dshGuard.lockedDesc', {
                                        procs: guardSnapshot.matchedProcesses.join(', ') || 'DSH',
                                      })
                                    : t('desktop.dshGuard.unlockedDesc'),
                                ),
                              ),
                            ),
                            h(
                              'div',
                              { style: { display: 'flex', gap: '8px', flex: 'none' } },
                              h(
                                Button,
                                { size: 'sm', onClick: () => void props.onRecheckGuard() },
                                Icons.refresh(),
                                h('span', null, t('desktop.guard.recheck')),
                              ),
                              isLockedDsh
                                ? h(
                                    Button,
                                    {
                                      size: 'sm',
                                      variant: 'warn',
                                      onClick: props.onRequestUnlockDsh,
                                    },
                                    t('desktop.guard.forceUnlock'),
                                  )
                                : h(
                                    Button,
                                    {
                                      size: 'sm',
                                      variant: 'primary',
                                      onClick: () => void props.onRelockDsh(),
                                    },
                                    t('desktop.guard.relock'),
                                  ),
                            ),
                          ),
                        )
                      : null,

                    // Snapshot card
                    h(
                      'div',
                      {
                        className: 'ml-surface-card',
                        style: {
                          padding: '20px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                        },
                      },
                      h(
                        'div',
                        { style: { fontSize: '13px', fontWeight: 600 } },
                        t('desktop.dshGuard.snapshotTitle'),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '12px',
                            fontSize: '12px',
                          },
                        },
                        h(
                          'div',
                          {
                            style: {
                              padding: '12px',
                              borderRadius: '10px',
                              background: 'var(--ml-panel-bg)',
                              boxShadow: 'inset 0 0 0 1px var(--ml-border)',
                            },
                          },
                          h(
                            'div',
                            { style: { color: 'var(--ml-text-muted)' } },
                            t('desktop.dshGuard.snapshotPathLabel'),
                          ),
                          h(
                            'div',
                            {
                              className: 'ml-mono',
                              style: { marginTop: '4px', wordBreak: 'break-all' },
                            },
                            'backups/memory-desktop-before-write-*.json',
                          ),
                        ),
                        h(
                          'div',
                          {
                            style: {
                              padding: '12px',
                              borderRadius: '10px',
                              background: 'var(--ml-panel-bg)',
                              boxShadow: 'inset 0 0 0 1px var(--ml-border)',
                            },
                          },
                          h(
                            'div',
                            { style: { color: 'var(--ml-text-muted)' } },
                            t('desktop.dshGuard.snapshotRuleLabel'),
                          ),
                          h(
                            'div',
                            { style: { marginTop: '4px', lineHeight: 1.5 } },
                            t('desktop.dshGuard.snapshotRuleDesc'),
                          ),
                        ),
                      ),
                    ),

                    // Read-only Profile Card
                    h(
                      'section',
                      {
                        className: 'ml-surface-card',
                        'aria-label': t('desktop.config.dshReadonlyTitle'),
                        style: {
                          padding: '20px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        },
                      },
                      h(
                        'h3',
                        { style: { margin: 0, fontSize: '14px', fontWeight: 600 } },
                        t('desktop.config.dshReadonlyTitle'),
                      ),
                      h(
                        'p',
                        {
                          style: {
                            margin: 0,
                            fontSize: '12px',
                            color: 'var(--ml-text-secondary)',
                            lineHeight: 1.55,
                          },
                        },
                        t('desktop.config.dshReadonlyDesc'),
                      ),
                      configResult?.reason !== undefined && configResult.reason !== ''
                        ? h(
                            'p',
                            {
                              className: 'ml-mono',
                              style: {
                                margin: '4px 0 0',
                                fontSize: '12px',
                                color: 'var(--ml-text-muted)',
                              },
                            },
                            configResult.reason,
                          )
                        : null,
                    ),
                  )
                : h(
                    React.Fragment,
                    null,
                    // Group 1: General & Capture
                    h(
                      'section',
                      { className: 'ml-surface-card', style: { padding: '6px 20px' } },
                      h(
                        'div',
                        {
                          style: {
                            padding: '10px 0',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--ml-text-muted)',
                            borderBottom: '1px solid var(--ml-border)',
                          },
                        },
                        t('desktop.config.groupGeneral'),
                      ),
                      h(Switch, {
                        label: t('desktop.config.enabled'),
                        hint: t('desktop.config.enabledHint'),
                        checked: draft.enabled,
                        disabled: saving,
                        onChange: (v) => updateDraft({ enabled: v }),
                      }),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(Switch, {
                          label: t('desktop.config.autoCaptureEpisodes'),
                          hint: t('desktop.config.autoCaptureEpisodesHint'),
                          checked: draft.autoCaptureEpisodes,
                          disabled: saving,
                          onChange: (v) => updateDraft({ autoCaptureEpisodes: v }),
                        }),
                      ),
                    ),

                    // Group 2: Automatic Dreaming (All AGY dream fields, no DSH model fields)
                    h(
                      'section',
                      { className: 'ml-surface-card', style: { padding: '6px 20px' } },
                      h(
                        'div',
                        {
                          style: {
                            padding: '10px 0',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--ml-text-muted)',
                            borderBottom: '1px solid var(--ml-border)',
                          },
                        },
                        t('config.groupDream'),
                      ),
                      h(Switch, {
                        label: t('config.autoDream'),
                        hint: t('config.autoDreamHint'),
                        checked: draft.autoDream,
                        disabled: saving,
                        onChange: (v) => updateDraft({ autoDream: v }),
                      }),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(Switch, {
                          label: t('config.autoAcceptProposals'),
                          hint: t('config.autoAcceptProposalsHint'),
                          checked: draft.autoAcceptProposals,
                          disabled: saving,
                          onChange: (v) => updateDraft({ autoAcceptProposals: v }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.dreamSubagentModel'),
                          hint: t('desktop.config.dreamSubagentModelHint'),
                          control: h(SegmentedControl<DreamSubagentModel>, {
                            label: t('desktop.config.dreamSubagentModel'),
                            value: draft.dreamSubagentModel,
                            onChange: (v) => updateDraft({ dreamSubagentModel: v }),
                            items: [
                              {
                                id: 'flash_lite',
                                label: t('desktop.config.subagentModel.flash_lite'),
                              },
                              { id: 'flash', label: t('desktop.config.subagentModel.flash') },
                              { id: 'pro', label: t('desktop.config.subagentModel.pro') },
                              { id: 'inherit', label: t('desktop.config.subagentModel.inherit') },
                            ],
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('config.dreamIdleDelaySec'),
                          hint: t('config.dreamIdleDelayHint'),
                          dim: !draft.autoDream,
                          control: h(NumericStepper, {
                            label: t('config.dreamIdleDelaySec'),
                            value: draft.dreamIdleDelaySec,
                            min: 0,
                            max: 86_400,
                            disabled: saving,
                            onChange: (v) => updateDraft({ dreamIdleDelaySec: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('config.autoDreamMinIntervalMs'),
                          hint: t('config.autoDreamMinIntervalHint'),
                          dim: !draft.autoDream,
                          control: h(NumericStepper, {
                            label: t('config.autoDreamMinIntervalMs'),
                            value: draft.autoDreamMinIntervalSec,
                            min: 0,
                            max: 604_800,
                            disabled: saving,
                            onChange: (v) => updateDraft({ autoDreamMinIntervalSec: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.dreamMaxEpisodes'),
                          control: h(NumericStepper, {
                            label: t('desktop.config.dreamMaxEpisodes'),
                            value: draft.dreamMaxEpisodes,
                            disabled: saving,
                            onChange: (v) => updateDraft({ dreamMaxEpisodes: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.dreamLookbackDays'),
                          control: h(NumericStepper, {
                            label: t('desktop.config.dreamLookbackDays'),
                            value: draft.dreamLookbackDays,
                            disabled: saving,
                            onChange: (v) => updateDraft({ dreamLookbackDays: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.dreamProcessingTimeoutMs'),
                          control: h(NumericStepper, {
                            label: t('desktop.config.dreamProcessingTimeoutMs'),
                            value: draft.dreamProcessingTimeoutMs,
                            step: 1000,
                            disabled: saving,
                            onChange: (v) => updateDraft({ dreamProcessingTimeoutMs: v }),
                          }),
                        }),
                      ),
                    ),

                    // Group 3: Index & Injection (Detented Slider + 5 fields)
                    h(
                      'section',
                      { className: 'ml-surface-card', style: { padding: '6px 20px' } },
                      h(
                        'div',
                        {
                          style: {
                            padding: '10px 0',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--ml-text-muted)',
                            borderBottom: '1px solid var(--ml-border)',
                          },
                        },
                        t('config.groupIndex'),
                      ),
                      h(DetentedSlider, {
                        label: t('config.indexMaxBytes'),
                        hint: formatMessage('config.indexMaxBytesHint', {
                          kb: (draft.indexMaxBytes / 1024).toFixed(1),
                        }),
                        value: draft.indexMaxBytes,
                        min: 1024,
                        max: 32768,
                        step: 512,
                        disabled: saving,
                        formatValue: (v) => `${v} B`,
                        detents: [
                          { value: 1024, label: '1 KB' },
                          { value: 4096, label: '4 KB' },
                          { value: 8192, label: '8 KB' },
                          { value: 16384, label: '16 KB' },
                          { value: 32768, label: '32 KB' },
                        ],
                        onChange: (v) => updateDraft({ indexMaxBytes: v }),
                      }),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(Switch, {
                          label: t('config.refreshIndexOnChange'),
                          hint: t('config.refreshIndexOnChangeHint'),
                          checked: draft.refreshIndexOnChange,
                          disabled: saving,
                          onChange: (v) => updateDraft({ refreshIndexOnChange: v }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.refreshMinIntervalMs'),
                          dim: !draft.refreshIndexOnChange,
                          control: h(NumericStepper, {
                            label: t('desktop.config.refreshMinIntervalMs'),
                            value: draft.refreshMinIntervalMs,
                            step: 1000,
                            disabled: saving,
                            onChange: (v) => updateDraft({ refreshMinIntervalMs: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.refreshMaxBytes'),
                          dim: !draft.refreshIndexOnChange,
                          control: h(NumericStepper, {
                            label: t('desktop.config.refreshMaxBytes'),
                            value: draft.refreshMaxBytes,
                            step: 256,
                            disabled: saving,
                            onChange: (v) => updateDraft({ refreshMaxBytes: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.refreshResetBytes'),
                          dim: !draft.refreshIndexOnChange,
                          control: h(NumericStepper, {
                            label: t('desktop.config.refreshResetBytes'),
                            value: draft.refreshResetBytes,
                            step: 512,
                            disabled: saving,
                            onChange: (v) => updateDraft({ refreshResetBytes: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(Switch, {
                          label: t('desktop.config.injectForSubagents'),
                          hint: t('desktop.config.injectForSubagentsHint'),
                          checked: draft.injectForSubagents,
                          disabled: saving,
                          onChange: (v) => updateDraft({ injectForSubagents: v }),
                        }),
                      ),
                    ),

                    // Group 4: Search & Worklog
                    h(
                      'section',
                      { className: 'ml-surface-card', style: { padding: '6px 20px' } },
                      h(
                        'div',
                        {
                          style: {
                            padding: '10px 0',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--ml-text-muted)',
                            borderBottom: '1px solid var(--ml-border)',
                          },
                        },
                        t('desktop.config.groupSearchWorklog'),
                      ),
                      h(SettingRow, {
                        label: t('desktop.config.searchLimit'),
                        control: h(NumericStepper, {
                          label: t('desktop.config.searchLimit'),
                          value: draft.searchLimit,
                          min: 1,
                          max: 200,
                          step: 5,
                          disabled: saving,
                          onChange: (v) => updateDraft({ searchLimit: v }),
                        }),
                      }),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.worklogCapture'),
                          control: h(Dropdown, {
                            label: t('desktop.config.worklogCapture'),
                            value: draft.worklogCapture,
                            disabled: saving,
                            options: [
                              {
                                value: 'significant',
                                label: t('desktop.config.worklogSignificant'),
                              },
                              { value: 'off', label: t('desktop.config.worklogOff') },
                            ],
                            onChange: (v) =>
                              updateDraft({ worklogCapture: v === 'off' ? 'off' : 'significant' }),
                          }),
                        }),
                      ),
                    ),

                    // Group 5: Retention, Purge & Rebuild
                    h(
                      'section',
                      { className: 'ml-surface-card', style: { padding: '6px 20px' } },
                      h(
                        'div',
                        {
                          style: {
                            padding: '10px 0',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--ml-text-muted)',
                            borderBottom: '1px solid var(--ml-border)',
                          },
                        },
                        t('desktop.config.groupRetention'),
                      ),
                      h(SettingRow, {
                        label: t('config.episodeRetentionDays'),
                        control: h(NumericStepper, {
                          label: t('config.episodeRetentionDays'),
                          value: draft.episodeRetentionDays,
                          disabled: saving,
                          onChange: (v) => updateDraft({ episodeRetentionDays: v }),
                        }),
                      }),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('config.worklogRetentionDays'),
                          control: h(NumericStepper, {
                            label: t('config.worklogRetentionDays'),
                            value: draft.worklogRetentionDays,
                            disabled: saving,
                            onChange: (v) => updateDraft({ worklogRetentionDays: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.archivePurgePolicy'),
                          control: h(Dropdown, {
                            label: t('desktop.config.archivePurgePolicy'),
                            value: draft.archivePurgePolicy,
                            disabled: saving,
                            options: [
                              { value: 'manual', label: t('desktop.config.purgeManual') },
                              {
                                value: 'after-export',
                                label: t('desktop.config.purgeAfterExport'),
                              },
                              { value: 'age', label: t('desktop.config.purgeAge') },
                            ],
                            onChange: (v) =>
                              updateDraft({
                                archivePurgePolicy:
                                  v === 'after-export' || v === 'age' ? v : 'manual',
                              }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.archiveRetentionDays'),
                          control: h(NumericStepper, {
                            label: t('desktop.config.archiveRetentionDays'),
                            value: draft.archiveRetentionDays,
                            disabled: saving,
                            onChange: (v) => updateDraft({ archiveRetentionDays: v }),
                          }),
                        }),
                      ),
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)' } },
                        h(SettingRow, {
                          label: t('desktop.config.rebuildLookbackDays'),
                          control: h(NumericStepper, {
                            label: t('desktop.config.rebuildLookbackDays'),
                            value: draft.rebuildLookbackDays,
                            disabled: saving,
                            onChange: (v) => updateDraft({ rebuildLookbackDays: v }),
                          }),
                        }),
                      ),
                    ),

                    // Group 6: Privacy & Maintenance
                    h(
                      'section',
                      { className: 'ml-surface-card', style: { padding: '6px 20px' } },
                      h(
                        'div',
                        {
                          style: {
                            padding: '10px 0',
                            fontSize: '12px',
                            fontWeight: 600,
                            color: 'var(--ml-text-muted)',
                            borderBottom: '1px solid var(--ml-border)',
                          },
                        },
                        t('config.groupPrivacy'),
                      ),
                      h(Switch, {
                        label: t('config.redactSecrets'),
                        hint: t('config.redactSecretsHint'),
                        checked: draft.redactSecrets,
                        disabled: saving,
                        onChange: (v) => updateDraft({ redactSecrets: v }),
                      }),
                    ),

                    // Data Backup & Maintenance
                    h(
                      'section',
                      {
                        className: 'ml-surface-card',
                        style: {
                          padding: '20px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                        },
                      },
                      h(
                        'div',
                        { style: { fontSize: '13px', fontWeight: 600 } },
                        t('desktop.config.maintenanceTitle'),
                      ),
                      h(
                        'p',
                        {
                          style: {
                            margin: 0,
                            fontSize: '12px',
                            color: 'var(--ml-text-secondary)',
                            lineHeight: 1.55,
                          },
                        },
                        t('desktop.config.maintenanceDesc'),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            flexWrap: 'wrap',
                          },
                        },
                        h(
                          'div',
                          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                          h(
                            Button,
                            { size: 'sm', onClick: () => void handleExport() },
                            Icons.download(),
                            h('span', null, t('transfer.exportTitle')),
                          ),
                          h(
                            Button,
                            {
                              size: 'sm',
                              disabled: !activeClient.writable,
                              onClick: () => void handleImport(),
                            },
                            Icons.upload(),
                            h('span', null, t('transfer.importTitle')),
                          ),
                          h(
                            Button,
                            {
                              size: 'sm',
                              disabled: !activeClient.writable,
                              onClick: () => setMaintModal('rebuild'),
                            },
                            Icons.refresh(),
                            h('span', null, t('desktop.config.rebuildBtn')),
                          ),
                        ),
                        h(
                          Button,
                          {
                            size: 'sm',
                            disabled: !activeClient.writable,
                            onClick: () => setMaintModal('purge'),
                          },
                          h(
                            'span',
                            { style: { color: 'var(--ml-danger)' } },
                            t('desktop.config.purgeBtn'),
                          ),
                        ),
                      ),
                    ),
                  ),
            ),

      // Floating Dirty Save Bar
      configResult?.editable === true && dirtyCount > 0
        ? h(
            'div',
            { className: 'ml-floating-bar' },
            h(
              'span',
              { className: 'ml-tabular', style: { fontSize: '12px', fontWeight: 500 } },
              formatMessage('desktop.config.unsavedCount', { count: dirtyCount }),
            ),
            h('div', {
              style: { width: '1px', height: '16px', background: 'var(--ml-border-strong)' },
            }),
            h(
              Button,
              {
                size: 'sm',
                disabled: saving,
                onClick: () => {
                  setDraft(baseline)
                  setRiskWarnings([])
                },
              },
              t('config.discard'),
            ),
            h(
              Button,
              {
                size: 'sm',
                variant: 'primary',
                disabled: saving,
                onClick: () => void saveAgyConfig(false),
              },
              saving ? t('common.saving') : t('common.save'),
            ),
          )
        : null,
    ),

    // Risk Confirmation Modal (disable redactSecrets / enable autoAccept / enable subagent injection)
    riskWarnings.length > 0
      ? h(
          Modal,
          {
            title: t('desktop.config.riskConfirmTitle'),
            closeLabel: t('common.close'),
            maxWidth: 460,
            onClose: () => setRiskWarnings([]),
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { disabled: saving, onClick: () => setRiskWarnings([]) },
                t('common.cancel'),
              ),
              h(
                Button,
                { variant: 'danger', disabled: saving, onClick: () => void saveAgyConfig(true) },
                t('common.confirm'),
              ),
            ),
          },
          h(
            'div',
            {
              role: 'alert',
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                fontSize: '13px',
                color: 'var(--ml-text-secondary)',
              },
            },
            riskWarnings.map((w, idx) =>
              h('p', { key: idx, style: { margin: 0, lineHeight: 1.55 } }, w),
            ),
          ),
        )
      : null,

    // Rebuild / Purge Maintenance Modal
    maintModal !== undefined
      ? h(
          Modal,
          {
            title:
              maintModal === 'rebuild'
                ? t('desktop.config.rebuildBtn')
                : t('desktop.config.purgeBtn'),
            closeLabel: t('common.close'),
            maxWidth: 440,
            onClose: () => setMaintModal(undefined),
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { disabled: saving, onClick: () => setMaintModal(undefined) },
                t('common.cancel'),
              ),
              h(
                Button,
                {
                  variant: maintModal === 'purge' ? 'danger' : 'primary',
                  disabled: saving,
                  onClick: () => void handleConfirmMaintenance(),
                },
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
            maintModal === 'rebuild'
              ? t('desktop.config.rebuildConfirm')
              : t('desktop.config.purgeConfirm'),
          ),
        )
      : null,
  )
}
