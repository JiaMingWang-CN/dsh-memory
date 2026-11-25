/**
 * Configuration sub-page for the 0.1.0 settings surface.
 *
 * Organized into four logical cards (Automatic dreaming, Index & injection,
 * Retention, Privacy & security) using DSH-style horizontal setting rows.
 * Only the design §8 fields exposed in 0.1.0 are shown; `autoCommitConfidence`
 * never appears. `autoDreamMinIntervalMs` is edited in human-friendly minutes
 * and persisted in milliseconds.
 * @module memloom/client/ConfigPanel
 */
import * as React from 'react'
import type { MemoryConfig, MemoryModelCatalog, MemoryModelEfforts } from './context.ts'
import { errorText } from './errors.ts'
import { formatMessage, t } from './locales.ts'
import { Button, NumericField, Select, Switch } from './ui.tsx'

const h = React.createElement

/** One option in the provider, model, or effort menu. */
type ModelOption = { value: string; label: string }

const MS_PER_SECOND = 1_000

/** Props accepted by {@link ConfigPanel}. */
export interface ConfigPanelProps {
  config: MemoryConfig
  onSave: (patch: Partial<MemoryConfig>) => void | Promise<void>
  saving?: boolean
  restartNotice?: boolean
  /** Providers and advertised models for the dream-model picker, when the Host reported them. */
  catalog?: MemoryModelCatalog
  /** Lazily resolve one model's advertised reasoning efforts. */
  loadEfforts?: (provider: string, model: string) => Promise<MemoryModelEfforts>
  /** Report whether the form holds unsaved edits, so the parent can mark the Settings tab. */
  onDirtyChange?: (dirty: boolean) => void
}

interface ConfigDraft {
  autoDream: boolean
  autoAcceptProposals: boolean
  dreamIdleDelaySec: number
  autoDreamMinIntervalSec: number
  indexMaxBytes: number
  refreshIndexOnChange: boolean
  dreamModelMode: 'follow-session' | 'fixed'
  dreamProvider: string
  dreamModel: string
  dreamReasoningEffort: string
  episodeRetentionDays: number
  worklogRetentionDays: number
  redactSecrets: boolean
}

function draftFromConfig(config: MemoryConfig): ConfigDraft {
  const idleMs = config.dreamIdleDelayMs ?? 30_000
  const intervalMs = config.autoDreamMinIntervalMs ?? 300_000
  return {
    autoDream: config.autoDream ?? false,
    autoAcceptProposals: config.autoAcceptProposals ?? false,
    dreamIdleDelaySec: Math.max(0, Math.round(idleMs / MS_PER_SECOND)),
    autoDreamMinIntervalSec: Math.max(0, Math.round(intervalMs / MS_PER_SECOND)),
    indexMaxBytes: config.indexMaxBytes ?? 4096,
    refreshIndexOnChange: config.refreshIndexOnChange ?? false,
    dreamModelMode: config.dreamModelMode ?? 'follow-session',
    dreamProvider: config.dreamProvider ?? '',
    dreamModel: config.dreamModel ?? '',
    dreamReasoningEffort: config.dreamReasoningEffort ?? '',
    episodeRetentionDays: config.episodeRetentionDays ?? 30,
    worklogRetentionDays: config.worklogRetentionDays ?? 90,
    redactSecrets: config.redactSecrets ?? true,
  }
}

function sameDraft(left: ConfigDraft, right: ConfigDraft): boolean {
  return (
    left.autoDream === right.autoDream &&
    left.autoAcceptProposals === right.autoAcceptProposals &&
    left.dreamIdleDelaySec === right.dreamIdleDelaySec &&
    left.autoDreamMinIntervalSec === right.autoDreamMinIntervalSec &&
    left.indexMaxBytes === right.indexMaxBytes &&
    left.refreshIndexOnChange === right.refreshIndexOnChange &&
    left.dreamModelMode === right.dreamModelMode &&
    left.dreamProvider === right.dreamProvider &&
    left.dreamModel === right.dreamModel &&
    left.dreamReasoningEffort === right.dreamReasoningEffort &&
    left.episodeRetentionDays === right.episodeRetentionDays &&
    left.worklogRetentionDays === right.worklogRetentionDays &&
    left.redactSecrets === right.redactSecrets
  )
}

/** Display label of a catalog entry. */
function optionLabel(entry: { id: string; name: string }): string {
  return entry.name === entry.id ? entry.id : `${entry.name} (${entry.id})`
}

/** Render one horizontal setting row: label + optional hint on the left, control on the right. */
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
 * Render the configuration form.
 * @param props - Current config and the save callback.
 * @returns The configuration panel element.
 */
export function ConfigPanel(props: ConfigPanelProps): React.ReactElement {
  const baseline = React.useMemo(() => draftFromConfig(props.config), [props.config])
  const [draft, setDraft] = React.useState<ConfigDraft>(() => baseline)
  const [error, setError] = React.useState('')
  const [savedNotice, setSavedNotice] = React.useState(false)
  const [efforts, setEfforts] = React.useState<ModelOption[]>([])
  const [savingLocal, setSavingLocal] = React.useState(false)
  const [confirmDisableRedact, setConfirmDisableRedact] = React.useState(false)
  const saving = props.saving === true || savingLocal
  const savedRedact = props.config.redactSecrets ?? true
  const dirty = !sameDraft(draft, baseline)

  // A saved (or reloaded) config is authoritative: rebuild the form from it so
  // the controls never show values the Host rejected or normalized.
  React.useEffect(() => {
    setDraft(baseline)
    setConfirmDisableRedact(false)
  }, [baseline])

  React.useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty, props.onDirtyChange])

  const follow = props.catalog?.defaultSelection
  const activeProvider =
    draft.dreamModelMode === 'fixed' ? draft.dreamProvider : (follow?.provider ?? '')
  const activeModel = draft.dreamModelMode === 'fixed' ? draft.dreamModel : (follow?.model ?? '')

  React.useEffect(() => {
    let cancelled = false
    if (props.loadEfforts === undefined || activeProvider === '' || activeModel === '') {
      setEfforts([])
      return undefined
    }
    props
      .loadEfforts(activeProvider, activeModel)
      .then((result) => {
        if (!cancelled)
          setEfforts(
            result.efforts.map((effort) => ({ value: effort.id, label: optionLabel(effort) })),
          )
      })
      .catch(() => {
        if (!cancelled) setEfforts([])
      })
    return () => {
      cancelled = true
    }
  }, [props.loadEfforts, activeProvider, activeModel])

  const update = (patch: Partial<ConfigDraft>): void => {
    setSavedNotice(false)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const save = async (confirmed = false): Promise<void> => {
    if (
      draft.dreamModelMode === 'fixed' &&
      (draft.dreamProvider.trim() === '' || draft.dreamModel.trim() === '')
    ) {
      setError(t('config.dreamModelRequired'))
      return
    }
    if (savedRedact && !draft.redactSecrets && !confirmed) {
      setError('')
      setConfirmDisableRedact(true)
      return
    }
    setConfirmDisableRedact(false)
    setError('')
    setSavedNotice(false)
    setSavingLocal(true)
    try {
      await props.onSave({
        autoDream: draft.autoDream,
        autoAcceptProposals: draft.autoAcceptProposals,
        dreamIdleDelayMs: draft.dreamIdleDelaySec * MS_PER_SECOND,
        autoDreamMinIntervalMs: draft.autoDreamMinIntervalSec * MS_PER_SECOND,
        indexMaxBytes: draft.indexMaxBytes,
        refreshIndexOnChange: draft.refreshIndexOnChange,
        dreamModelMode: draft.dreamModelMode,
        dreamProvider: draft.dreamModelMode === 'fixed' ? draft.dreamProvider : '',
        dreamModel: draft.dreamModelMode === 'fixed' ? draft.dreamModel : '',
        dreamReasoningEffort: draft.dreamReasoningEffort,
        episodeRetentionDays: draft.episodeRetentionDays,
        worklogRetentionDays: draft.worklogRetentionDays,
        redactSecrets: draft.redactSecrets,
      })
      setError('')
      setSavedNotice(true)
    } catch (reason) {
      setError(`${t('config.saveFailed')} ${errorText(reason)}`)
    } finally {
      setSavingLocal(false)
    }
  }

  const numberControl = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    limits: { min?: number; max?: number } = {},
  ) =>
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

  const providers = props.catalog?.providers ?? []
  const modelsFor = (provider: string): ModelOption[] =>
    (props.catalog?.models[provider] ?? []).map((entry) => ({
      value: entry.id,
      label: optionLabel(entry),
    }))
  const providerOptions = (): ModelOption[] => {
    const options = providers.map((entry) => ({ value: entry.id, label: optionLabel(entry) }))
    if (
      draft.dreamProvider !== '' &&
      !options.some((option) => option.value === draft.dreamProvider)
    ) {
      options.unshift({ value: draft.dreamProvider, label: draft.dreamProvider })
    }
    return [{ value: '', label: t('config.selectProvider') }, ...options]
  }
  const modelOptions = (): ModelOption[] => {
    const options = modelsFor(draft.dreamProvider)
    if (draft.dreamModel !== '' && !options.some((option) => option.value === draft.dreamModel)) {
      options.unshift({ value: draft.dreamModel, label: draft.dreamModel })
    }
    return [{ value: '', label: t('config.selectModel') }, ...options]
  }
  const effortOptions = (): ModelOption[] => {
    if (
      draft.dreamReasoningEffort !== '' &&
      !efforts.some((option) => option.value === draft.dreamReasoningEffort)
    ) {
      return [
        { value: '', label: t('config.selectEffort') },
        { value: draft.dreamReasoningEffort, label: draft.dreamReasoningEffort },
        ...efforts,
      ]
    }
    return [{ value: '', label: t('config.selectEffort') }, ...efforts]
  }

  const followLabel = (): string => {
    if (follow === undefined) return t('config.followModelMissing')
    const providerName =
      props.catalog?.providers.find((provider) => provider.id === follow.provider)?.name ??
      follow.provider
    const modelName =
      props.catalog?.models[follow.provider]?.find((model) => model.id === follow.model)?.name ??
      follow.model
    return `${providerName} / ${modelName}`
  }

  const indexKb = (draft.indexMaxBytes / 1024).toFixed(1)

  return h(
    'div',
    { className: 'dsh-mem-stack' },
    // Group 1: Automatic dreaming
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('config.groupDream')),
      h('p', { className: 'dsh-mem-section-sub' }, t('config.subtitle')),
      h(Switch, {
        label: t('config.autoDream'),
        hint: t('config.autoDreamHint'),
        checked: draft.autoDream,
        disabled: saving,
        onChange: (value: boolean) => update({ autoDream: value }),
      }),
      h(Switch, {
        label: t('config.autoAcceptProposals'),
        hint: t('config.autoAcceptProposalsHint'),
        checked: draft.autoAcceptProposals,
        disabled: saving,
        onChange: (value: boolean) => update({ autoAcceptProposals: value }),
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
        label: t('config.dreamModelMode'),
        ...(draft.dreamModelMode === 'follow-session' ? { hint: followLabel() } : {}),
        control: h(Select, {
          label: t('config.dreamModelMode'),
          value: draft.dreamModelMode,
          disabled: saving,
          options: [
            { value: 'follow-session', label: t('config.dreamModeFollow') },
            { value: 'fixed', label: t('config.dreamModeFixed') },
          ],
          onChange: (value) =>
            update({
              dreamModelMode: value === 'fixed' ? 'fixed' : 'follow-session',
              dreamReasoningEffort: '',
            }),
        }),
      }),
      draft.dreamModelMode === 'fixed'
        ? h(SettingRow, {
            label: t('config.dreamProvider'),
            control: h(Select, {
              label: t('config.dreamProvider'),
              value: draft.dreamProvider,
              options: providerOptions(),
              ...(providers.length === 0 || saving ? { disabled: true } : {}),
              onChange: (value) =>
                update({ dreamProvider: value, dreamModel: '', dreamReasoningEffort: '' }),
            }),
          })
        : null,
      draft.dreamModelMode === 'fixed'
        ? h(SettingRow, {
            label: t('config.dreamModel'),
            control: h(Select, {
              label: t('config.dreamModel'),
              value: draft.dreamModel,
              options: modelOptions(),
              ...(draft.dreamProvider === '' ||
              modelsFor(draft.dreamProvider).length === 0 ||
              saving
                ? { disabled: true }
                : {}),
              onChange: (value) => update({ dreamModel: value, dreamReasoningEffort: '' }),
            }),
          })
        : null,
      h(SettingRow, {
        label: t('config.dreamReasoningEffort'),
        ...(efforts.length === 0 ? { hint: t('config.noEfforts') } : {}),
        control: h(Select, {
          label: t('config.dreamReasoningEffort'),
          value: draft.dreamReasoningEffort,
          options: effortOptions(),
          ...(efforts.length === 0 || saving ? { disabled: true } : {}),
          onChange: (value) => update({ dreamReasoningEffort: value }),
        }),
      }),
    ),
    // Group 2: Index & injection
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
        onChange: (value: boolean) => update({ refreshIndexOnChange: value }),
      }),
    ),
    // Group 3: Retention
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('config.groupRetention')),
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
    ),
    // Group 4: Privacy & security
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('config.groupPrivacy')),
      h(Switch, {
        label: t('config.redactSecrets'),
        hint: t('config.redactSecretsHint'),
        checked: draft.redactSecrets,
        disabled: saving,
        onChange: (value: boolean) => {
          update({ redactSecrets: value })
          if (value) setConfirmDisableRedact(false)
        },
      }),
      confirmDisableRedact
        ? h(
            'div',
            { className: 'dsh-mem-confirm', role: 'alert' },
            h('span', null, t('config.confirmDisableRedact')),
            h(
              Button,
              {
                variant: 'danger',
                size: 'sm',
                ...(saving ? { disabled: true } : {}),
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
                ...(saving ? { disabled: true } : {}),
                onClick: () => setConfirmDisableRedact(false),
              },
              t('common.cancel'),
            ),
          )
        : null,
    ),
    error !== '' ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, error) : null,
    props.restartNotice === true
      ? h('div', { className: 'dsh-mem-warning', role: 'status' }, t('config.restartNotice'))
      : savedNotice
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
                ...(saving ? { disabled: true } : {}),
                onClick: () => {
                  setDraft(baseline)
                  setError('')
                  setConfirmDisableRedact(false)
                },
              },
              t('config.discard'),
            )
          : null,
        h(
          Button,
          {
            variant: 'primary',
            ...(saving ? { disabled: true } : {}),
            onClick: () => {
              void save()
            },
          },
          saving ? t('common.saving') : t('common.save'),
        ),
      ),
    ),
  )
}
