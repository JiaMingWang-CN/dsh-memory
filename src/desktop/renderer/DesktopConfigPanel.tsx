/**
 * Desktop configuration panel rendering all 23 `AGY_EDITABLE_CONFIG_FIELDS` for
 * AGY/agy-flat stores (without DSH model fields) and a read-only info card for
 * DSH Profile-managed stores.
 * @module memloom/desktop/renderer/DesktopConfigPanel
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import { Button, NumericField, Select, Switch } from '../../client/ui.tsx'
import {
  AGY_EDITABLE_CONFIG_FIELDS,
  MEMORY_CONFIG_DEFAULTS,
  type MemoryConfig,
  type ResolvedMemoryConfig,
} from '../../core/config.ts'
import type { DesktopClientConfigResult } from '../multi-service.ts'
import { desktopErrorText } from './desktop-locales.ts'

const h = React.createElement

const MS_PER_SECOND = 1_000

export interface DesktopConfigPanelProps {
  readonly configResult: DesktopClientConfigResult
  readonly onSave: (patch: Partial<MemoryConfig>) => Promise<void>
  readonly onDirtyChange?: (dirty: boolean) => void
}

interface AgyConfigDraft {
  enabled: boolean
  indexMaxBytes: number
  autoCaptureEpisodes: boolean
  autoDream: boolean
  autoAcceptProposals: boolean
  dreamIdleDelaySec: number
  autoDreamMinIntervalSec: number
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

function sameDraft(left: AgyConfigDraft, right: AgyConfigDraft): boolean {
  return (
    left.enabled === right.enabled &&
    left.indexMaxBytes === right.indexMaxBytes &&
    left.autoCaptureEpisodes === right.autoCaptureEpisodes &&
    left.autoDream === right.autoDream &&
    left.autoAcceptProposals === right.autoAcceptProposals &&
    left.dreamIdleDelaySec === right.dreamIdleDelaySec &&
    left.autoDreamMinIntervalSec === right.autoDreamMinIntervalSec &&
    left.dreamMaxEpisodes === right.dreamMaxEpisodes &&
    left.dreamLookbackDays === right.dreamLookbackDays &&
    left.dreamProcessingTimeoutMs === right.dreamProcessingTimeoutMs &&
    left.refreshIndexOnChange === right.refreshIndexOnChange &&
    left.refreshMinIntervalMs === right.refreshMinIntervalMs &&
    left.refreshMaxBytes === right.refreshMaxBytes &&
    left.refreshResetBytes === right.refreshResetBytes &&
    left.worklogCapture === right.worklogCapture &&
    left.worklogRetentionDays === right.worklogRetentionDays &&
    left.episodeRetentionDays === right.episodeRetentionDays &&
    left.archivePurgePolicy === right.archivePurgePolicy &&
    left.archiveRetentionDays === right.archiveRetentionDays &&
    left.rebuildLookbackDays === right.rebuildLookbackDays &&
    left.injectForSubagents === right.injectForSubagents &&
    left.redactSecrets === right.redactSecrets &&
    left.searchLimit === right.searchLimit
  )
}

function SettingRow(props: {
  label: string
  hint?: string
  dim?: boolean
  control: React.ReactNode
}): React.ReactElement {
  return h(
    'div',
    { className: 'dsh-mem-setting-row', ...(props.dim === true ? { 'data-dim': 'true' } : {}) },
    h(
      'span',
      { className: 'dsh-mem-switchtext' },
      h('span', { className: 'dsh-mem-switchlabel' }, props.label),
      props.hint === undefined ? null : h('span', { className: 'dsh-mem-switchhint' }, props.hint),
    ),
    h('div', { className: 'dsh-mem-setting-control' }, props.control),
  )
}

/**
 * Render AGY 23-field settings form or DSH read-only profile notice card.
 */
export function DesktopConfigPanel(props: DesktopConfigPanelProps): React.ReactElement {
  const { configResult } = props
  const editableFields = React.useMemo(
    () => new Set<keyof MemoryConfig>(configResult.editableFields ?? AGY_EDITABLE_CONFIG_FIELDS),
    [configResult.editableFields],
  )
  const baseline = React.useMemo(
    () => draftFromResolved(configResult.config),
    [configResult.config],
  )
  const [draft, setDraft] = React.useState<AgyConfigDraft>(() => baseline)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [savedNotice, setSavedNotice] = React.useState(false)
  const [riskWarnings, setRiskWarnings] = React.useState<string[]>([])

  React.useEffect(() => {
    setDraft(baseline)
    setRiskWarnings([])
  }, [baseline])

  const dirty = configResult.editable && !sameDraft(draft, baseline)
  React.useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty, props.onDirtyChange])

  if (!configResult.editable) {
    return h(
      'section',
      {
        className: 'memloom-config-readonly-card',
        'aria-label': t('desktop.config.dshReadonlyTitle'),
      },
      h('h3', { className: 'dsh-mem-section-title' }, t('desktop.config.dshReadonlyTitle')),
      h('p', { className: 'dsh-mem-hint' }, t('desktop.config.dshReadonlyDesc')),
      configResult.reason !== undefined && configResult.reason !== ''
        ? h('p', { className: 'dsh-mem-section-sub' }, configResult.reason)
        : null,
    )
  }

  const update = (patch: Partial<AgyConfigDraft>): void => {
    setSavedNotice(false)
    setRiskWarnings([])
    setDraft((current) => ({ ...current, ...patch }))
  }

  const collectRiskWarnings = (): string[] => {
    const warnings: string[] = []
    if (baseline.redactSecrets && !draft.redactSecrets) {
      warnings.push(t('config.confirmDisableRedact'))
    }
    if (!baseline.autoAcceptProposals && draft.autoAcceptProposals) {
      warnings.push(t('desktop.config.confirmAutoAccept'))
    }
    if (!baseline.injectForSubagents && draft.injectForSubagents) {
      warnings.push(t('desktop.config.confirmInjectSubagents'))
    }
    return warnings
  }

  const save = async (confirmed = false): Promise<void> => {
    if (!confirmed) {
      const warnings = collectRiskWarnings()
      if (warnings.length > 0) {
        setError('')
        setRiskWarnings(warnings)
        return
      }
    }
    setRiskWarnings([])
    setError('')
    setSavedNotice(false)
    setSaving(true)
    try {
      const fullPatch: Partial<MemoryConfig> = {
        enabled: draft.enabled,
        indexMaxBytes: draft.indexMaxBytes,
        autoCaptureEpisodes: draft.autoCaptureEpisodes,
        autoDream: draft.autoDream,
        autoAcceptProposals: draft.autoAcceptProposals,
        dreamIdleDelayMs: draft.dreamIdleDelaySec * MS_PER_SECOND,
        autoDreamMinIntervalMs: draft.autoDreamMinIntervalSec * MS_PER_SECOND,
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
        if (editableFields.has(field)) {
          ;(patch as Record<string, unknown>)[field] = (fullPatch as Record<string, unknown>)[field]
        }
      }
      await props.onSave(patch)
      setSavedNotice(true)
    } catch (reason) {
      setError(`${t('config.saveFailed')} ${desktopErrorText(reason)}`)
    } finally {
      setSaving(false)
    }
  }

  const numberControl = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    limits: { min?: number; max?: number } = {},
  ): React.ReactElement =>
    h(NumericField, {
      label,
      value,
      integer: true,
      min: limits.min ?? 0,
      max: limits.max ?? Number.MAX_SAFE_INTEGER,
      step: 1,
      disabled: saving,
      onChange,
    })

  const indexKb = (draft.indexMaxBytes / 1024).toFixed(1)

  return h(
    'div',
    { className: 'dsh-mem-stack' },
    // Group 1: General & Capture
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('desktop.config.groupGeneral')),
      h(Switch, {
        label: t('desktop.config.enabled'),
        hint: t('desktop.config.enabledHint'),
        checked: draft.enabled,
        disabled: saving,
        onChange: (value) => update({ enabled: value }),
      }),
      h(Switch, {
        label: t('desktop.config.autoCaptureEpisodes'),
        hint: t('desktop.config.autoCaptureEpisodesHint'),
        checked: draft.autoCaptureEpisodes,
        disabled: saving,
        onChange: (value) => update({ autoCaptureEpisodes: value }),
      }),
    ),
    // Group 2: Automatic Dreaming (without DSH model selection fields)
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('config.groupDream')),
      h(Switch, {
        label: t('config.autoDream'),
        hint: t('config.autoDreamHint'),
        checked: draft.autoDream,
        disabled: saving,
        onChange: (value) => update({ autoDream: value }),
      }),
      h(Switch, {
        label: t('config.autoAcceptProposals'),
        hint: t('config.autoAcceptProposalsHint'),
        checked: draft.autoAcceptProposals,
        disabled: saving,
        onChange: (value) => update({ autoAcceptProposals: value }),
      }),
      h(SettingRow, {
        label: t('config.dreamIdleDelaySec'),
        hint: t('config.dreamIdleDelayHint'),
        dim: !draft.autoDream,
        control: numberControl(
          t('config.dreamIdleDelaySec'),
          draft.dreamIdleDelaySec,
          (value) => update({ dreamIdleDelaySec: value }),
          { min: 0, max: 86_400 },
        ),
      }),
      h(SettingRow, {
        label: t('config.autoDreamMinIntervalMs'),
        hint: t('config.autoDreamMinIntervalHint'),
        dim: !draft.autoDream,
        control: numberControl(
          t('config.autoDreamMinIntervalMs'),
          draft.autoDreamMinIntervalSec,
          (value) => update({ autoDreamMinIntervalSec: value }),
          { min: 0, max: 604_800 },
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.dreamMaxEpisodes'),
        control: numberControl(
          t('desktop.config.dreamMaxEpisodes'),
          draft.dreamMaxEpisodes,
          (value) => update({ dreamMaxEpisodes: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.dreamLookbackDays'),
        control: numberControl(
          t('desktop.config.dreamLookbackDays'),
          draft.dreamLookbackDays,
          (value) => update({ dreamLookbackDays: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.dreamProcessingTimeoutMs'),
        control: numberControl(
          t('desktop.config.dreamProcessingTimeoutMs'),
          draft.dreamProcessingTimeoutMs,
          (value) => update({ dreamProcessingTimeoutMs: value }),
        ),
      }),
    ),
    // Group 3: Index & Injection
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('config.groupIndex')),
      h(SettingRow, {
        label: t('config.indexMaxBytes'),
        hint: formatMessage('config.indexMaxBytesHint', { kb: indexKb }),
        control: numberControl(
          t('config.indexMaxBytes'),
          draft.indexMaxBytes,
          (value) => update({ indexMaxBytes: value }),
          { min: 1024, max: 32768 },
        ),
      }),
      h(Switch, {
        label: t('config.refreshIndexOnChange'),
        hint: t('config.refreshIndexOnChangeHint'),
        checked: draft.refreshIndexOnChange,
        disabled: saving,
        onChange: (value) => update({ refreshIndexOnChange: value }),
      }),
      h(SettingRow, {
        label: t('desktop.config.refreshMinIntervalMs'),
        dim: !draft.refreshIndexOnChange,
        control: numberControl(
          t('desktop.config.refreshMinIntervalMs'),
          draft.refreshMinIntervalMs,
          (value) => update({ refreshMinIntervalMs: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.refreshMaxBytes'),
        dim: !draft.refreshIndexOnChange,
        control: numberControl(
          t('desktop.config.refreshMaxBytes'),
          draft.refreshMaxBytes,
          (value) => update({ refreshMaxBytes: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.refreshResetBytes'),
        dim: !draft.refreshIndexOnChange,
        control: numberControl(
          t('desktop.config.refreshResetBytes'),
          draft.refreshResetBytes,
          (value) => update({ refreshResetBytes: value }),
        ),
      }),
      h(Switch, {
        label: t('desktop.config.injectForSubagents'),
        hint: t('desktop.config.injectForSubagentsHint'),
        checked: draft.injectForSubagents,
        disabled: saving,
        onChange: (value) => update({ injectForSubagents: value }),
      }),
    ),
    // Group 4: Search & Worklog
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('desktop.config.groupSearchWorklog')),
      h(SettingRow, {
        label: t('desktop.config.searchLimit'),
        control: numberControl(t('desktop.config.searchLimit'), draft.searchLimit, (value) =>
          update({ searchLimit: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.worklogCapture'),
        control: h(Select, {
          label: t('desktop.config.worklogCapture'),
          value: draft.worklogCapture,
          disabled: saving,
          options: [
            { value: 'significant', label: t('desktop.config.worklogSignificant') },
            { value: 'off', label: t('desktop.config.worklogOff') },
          ],
          onChange: (value) => update({ worklogCapture: value === 'off' ? 'off' : 'significant' }),
        }),
      }),
    ),
    // Group 5: Retention, Purge & Rebuild
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('desktop.config.groupRetention')),
      h(SettingRow, {
        label: t('config.episodeRetentionDays'),
        control: numberControl(
          t('config.episodeRetentionDays'),
          draft.episodeRetentionDays,
          (value) => update({ episodeRetentionDays: value }),
        ),
      }),
      h(SettingRow, {
        label: t('config.worklogRetentionDays'),
        control: numberControl(
          t('config.worklogRetentionDays'),
          draft.worklogRetentionDays,
          (value) => update({ worklogRetentionDays: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.archivePurgePolicy'),
        control: h(Select, {
          label: t('desktop.config.archivePurgePolicy'),
          value: draft.archivePurgePolicy,
          disabled: saving,
          options: [
            { value: 'manual', label: t('desktop.config.purgeManual') },
            { value: 'after-export', label: t('desktop.config.purgeAfterExport') },
            { value: 'age', label: t('desktop.config.purgeAge') },
          ],
          onChange: (value) =>
            update({
              archivePurgePolicy: value === 'after-export' || value === 'age' ? value : 'manual',
            }),
        }),
      }),
      h(SettingRow, {
        label: t('desktop.config.archiveRetentionDays'),
        control: numberControl(
          t('desktop.config.archiveRetentionDays'),
          draft.archiveRetentionDays,
          (value) => update({ archiveRetentionDays: value }),
        ),
      }),
      h(SettingRow, {
        label: t('desktop.config.rebuildLookbackDays'),
        control: numberControl(
          t('desktop.config.rebuildLookbackDays'),
          draft.rebuildLookbackDays,
          (value) => update({ rebuildLookbackDays: value }),
        ),
      }),
    ),
    // Group 6: Privacy & Security
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('config.groupPrivacy')),
      h(Switch, {
        label: t('config.redactSecrets'),
        hint: t('config.redactSecretsHint'),
        checked: draft.redactSecrets,
        disabled: saving,
        onChange: (value) => update({ redactSecrets: value }),
      }),
    ),
    riskWarnings.length > 0
      ? h(
          'div',
          { className: 'dsh-mem-confirm', role: 'alert' },
          h(
            'div',
            { className: 'dsh-mem-stack', style: { gap: '4px', flex: '1 1 280px' } },
            h('strong', null, t('desktop.config.riskConfirmTitle')),
            ...riskWarnings.map((warning, idx) => h('span', { key: idx }, warning)),
          ),
          h(
            Button,
            {
              variant: 'danger',
              size: 'sm',
              disabled: saving,
              onClick: () => {
                void save(true)
              },
            },
            t('common.confirm'),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: saving,
              onClick: () => setRiskWarnings([]),
            },
            t('common.cancel'),
          ),
        )
      : null,
    error !== '' ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, error) : null,
    savedNotice
      ? h('div', { className: 'dsh-mem-notice', role: 'status' }, t('config.saved'))
      : null,
    h(
      'div',
      { className: 'dsh-mem-config-bar' },
      h('span', { className: 'dsh-mem-hint' }, dirty ? t('config.unsaved') : t('config.title')),
      h(
        'div',
        { className: 'dsh-mem-actions' },
        dirty
          ? h(
              Button,
              {
                variant: 'ghost',
                disabled: saving,
                onClick: () => {
                  setDraft(baseline)
                  setError('')
                  setRiskWarnings([])
                },
              },
              t('config.discard'),
            )
          : null,
        h(
          Button,
          {
            variant: 'primary',
            disabled: !dirty || saving,
            onClick: () => {
              void save(false)
            },
          },
          saving ? t('common.saving') : t('common.save'),
        ),
      ),
    ),
  )
}
