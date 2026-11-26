/**
 * Cross-client migration wizard modal supporting full scope migration (merge/replace)
 * and direct record migration (strictly locked to merge mode).
 * @module memloom/desktop/renderer/MigrationWizardModal
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import { Button, Modal, Select, Switch, Tag } from '../../client/ui.tsx'
import { workspaceKeyOf } from '../../client/WorkspaceFilter.tsx'
import type { WorkspaceSummary } from '../../core/engine.ts'
import type { ExportScope, ImportReport, WorkspaceMapping } from '../../core/exchange.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type {
  DesktopClientInfo,
  MigrationPreviewResult,
  MigrationSourceSelection,
} from '../multi-service.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'

const h = React.createElement
const Fragment = React.Fragment

export interface MigrationWizardModalProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly initialSourceClientId?: string
  readonly initialTargetClientId?: string
  readonly initialSelection?: MigrationSourceSelection
  readonly onClose: () => void
  readonly onSuccess: (report: ImportReport) => void | Promise<void>
  readonly onExternalChange?: () => void
}

type WizardStep = 'source' | 'preview' | 'report'
type ScopeKind = 'all' | 'global' | 'workspace'
type TargetScopeKind = 'all' | 'global' | 'workspace'

function scopeLabel(scope: ExportScope): string {
  if (scope === 'all') return t('desktop.migrate.targetScopeAll')
  if (scope === 'global') return t('desktop.migrate.targetScopeGlobal')
  return scope.workspaceKey
}

/**
 * Interactive cross-client migration wizard enforcing `replace` non-skip,
 * `targetScope` containment, and explicit confirmation rules.
 */
export function MigrationWizardModal(props: MigrationWizardModalProps): React.ReactElement {
  const isRecordsMode = props.initialSelection?.kind === 'records'
  const readySources = React.useMemo(
    () => props.clients.filter((c) => c.health === 'ready'),
    [props.clients],
  )

  const defaultSourceId =
    props.initialSourceClientId ?? readySources[0]?.id ?? props.clients[0]?.id ?? ''
  const [sourceClientId, setSourceClientId] = React.useState(defaultSourceId)

  const candidateTargets = React.useMemo(
    () => props.clients.filter((c) => c.id !== sourceClientId),
    [props.clients, sourceClientId],
  )
  const defaultTargetId = React.useMemo(() => {
    if (
      props.initialTargetClientId !== undefined &&
      props.initialTargetClientId !== sourceClientId
    ) {
      return props.initialTargetClientId
    }
    const writableTarget = candidateTargets.find(
      (c) =>
        c.writable &&
        c.health !== 'corrupted' &&
        c.health !== 'unreadable' &&
        (c.health !== 'missing' || c.allowInitializeWhenMissing),
    )
    return writableTarget?.id ?? candidateTargets[0]?.id ?? ''
  }, [props.initialTargetClientId, sourceClientId, candidateTargets])

  const [targetClientId, setTargetClientId] = React.useState(defaultTargetId)
  React.useEffect(() => {
    if (
      targetClientId === sourceClientId ||
      !candidateTargets.some((c) => c.id === targetClientId)
    ) {
      setTargetClientId(candidateTargets[0]?.id ?? '')
    }
  }, [sourceClientId, targetClientId, candidateTargets])

  const [sourceWorkspacesList, setSourceWorkspacesList] = React.useState<WorkspaceSummary[]>([])
  const [scopeKind, setScopeKind] = React.useState<ScopeKind>(() => {
    if (props.initialSelection?.kind === 'scope') {
      if (props.initialSelection.scope === 'global') return 'global'
      if (typeof props.initialSelection.scope === 'object') return 'workspace'
    }
    return 'all'
  })
  const [sourceWorkspaceKey, setSourceWorkspaceKey] = React.useState<string>(() => {
    if (
      props.initialSelection?.kind === 'scope' &&
      typeof props.initialSelection.scope === 'object'
    ) {
      return props.initialSelection.scope.workspaceKey
    }
    return ''
  })
  const [includeArchived, setIncludeArchived] = React.useState<boolean>(
    props.initialSelection?.kind === 'scope'
      ? (props.initialSelection.includeArchived ?? true)
      : true,
  )
  const [includeEpisodes, setIncludeEpisodes] = React.useState<boolean>(
    props.initialSelection?.kind === 'scope'
      ? (props.initialSelection.includeEpisodes ?? true)
      : true,
  )
  const [mode, setMode] = React.useState<'merge' | 'replace'>('merge')

  const [step, setStep] = React.useState<WizardStep>('source')
  const [preview, setPreview] = React.useState<MigrationPreviewResult | undefined>(undefined)
  const [mapping, setMapping] = React.useState<
    Record<string, { key: string; root: string } | null>
  >({})
  const [customTargets, setCustomTargets] = React.useState<Array<{ key: string; root: string }>>([])
  const [targetScopeKind, setTargetScopeKind] = React.useState<TargetScopeKind>('all')
  const [targetScopeWorkspaceKey, setTargetScopeWorkspaceKey] = React.useState<string>('')
  const [confirmReplace, setConfirmReplace] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [report, setReport] = React.useState<ImportReport | undefined>(undefined)

  React.useEffect(() => {
    if (isRecordsMode || sourceClientId === '') {
      setSourceWorkspacesList([])
      return undefined
    }
    let cancelled = false
    void props.bridge.memory
      .listWorkspaces({ clientId: sourceClientId })
      .then((res) => {
        if (cancelled) return
        const list = unwrapIpc(res)
        setSourceWorkspacesList(list)
        if (list.length > 0 && sourceWorkspaceKey === '') {
          setSourceWorkspaceKey(list[0]!.key)
        }
      })
      .catch(() => {
        if (!cancelled) setSourceWorkspacesList([])
      })
    return () => {
      cancelled = true
    }
  }, [props.bridge, sourceClientId, isRecordsMode])

  const buildSelection = (): MigrationSourceSelection => {
    if (isRecordsMode && props.initialSelection?.kind === 'records') {
      return props.initialSelection
    }
    const scope: ExportScope =
      scopeKind === 'all'
        ? 'all'
        : scopeKind === 'global'
          ? 'global'
          : { workspaceKey: sourceWorkspaceKey }
    return {
      kind: 'scope',
      scope,
      includeArchived,
      includeEpisodes,
    }
  }

  const runPreview = async (): Promise<void> => {
    if (sourceClientId === '' || targetClientId === '' || sourceClientId === targetClientId) {
      setError(t('desktop.migrate.sameClientError'))
      return
    }
    setBusy(true)
    setError('')
    setConfirmReplace(false)
    try {
      const selection = buildSelection()
      const res = unwrapIpc(
        await props.bridge.migration.preview({
          sourceClientId,
          targetClientId,
          selection,
        }),
      )
      setPreview(res)
      const initialMap: Record<string, { key: string; root: string } | null> = {}
      const extraTargets: Array<{ key: string; root: string }> = []
      const knownTargetKeys = new Set(res.targetWorkspaces.map((w) => w.key))
      for (const ws of res.sourceWorkspaces) {
        const suggested = res.suggestedMapping[ws.key]
        if (suggested !== undefined) {
          initialMap[ws.key] = suggested
          if (!knownTargetKeys.has(suggested.key)) {
            knownTargetKeys.add(suggested.key)
            extraTargets.push(suggested)
          }
        } else {
          initialMap[ws.key] = null
        }
      }
      setMapping(initialMap)
      setCustomTargets(extraTargets)
      if (!res.allowReplace && mode === 'replace') {
        setMode('merge')
      }
      const firstWs = res.targetWorkspaces[0]?.key ?? res.sourceWorkspaces[0]?.key ?? ''
      setTargetScopeWorkspaceKey(firstWs)
      setTargetScopeKind('all')
      setStep('preview')
    } catch (reason) {
      if (isExternalChangeError(reason)) props.onExternalChange?.()
      setError(desktopErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const allTargetWorkspaceChoices = React.useMemo(() => {
    const map = new Map<string, { key: string; root: string }>()
    for (const ws of preview?.targetWorkspaces ?? []) {
      map.set(ws.key, { key: ws.key, root: ws.root })
    }
    for (const ct of customTargets) {
      if (!map.has(ct.key)) map.set(ct.key, ct)
    }
    return [...map.values()]
  }, [preview, customTargets])

  const effectiveTargetScope: ExportScope =
    targetScopeKind === 'all'
      ? 'all'
      : targetScopeKind === 'global'
        ? 'global'
        : { workspaceKey: targetScopeWorkspaceKey }

  const effectiveMode: 'merge' | 'replace' = isRecordsMode ? 'merge' : mode

  const hasSkippedSourceWorkspace =
    preview !== undefined &&
    preview.sourceWorkspaces.some((ws) => mapping[ws.key] === null || mapping[ws.key] === undefined)

  const hasOutOfScopeMapping =
    effectiveMode === 'replace' &&
    preview !== undefined &&
    preview.sourceWorkspaces.some((ws) => {
      const target = mapping[ws.key]
      if (target === null || target === undefined) return false
      if (effectiveTargetScope === 'all') return false
      if (effectiveTargetScope === 'global') return true
      return target.key !== effectiveTargetScope.workspaceKey
    })

  const validationReason =
    preview === undefined
      ? ''
      : !preview.targetWritable
        ? t('desktop.migrate.targetReadonlyError')
        : effectiveMode === 'replace' && hasSkippedSourceWorkspace
          ? t('desktop.migrate.replaceNoSkipError')
          : effectiveMode === 'replace' && hasOutOfScopeMapping
            ? t('desktop.migrate.replaceScopeError')
            : ''

  const pickDirectoryForWorkspace = async (sourceKey: string): Promise<void> => {
    setError('')
    try {
      const dir = unwrapIpc(await props.bridge.dialog.pickDirectory())
      if (dir === null || dir === '') return
      const key = workspaceKeyOf(dir)
      const entry = { key, root: dir }
      setCustomTargets((current) =>
        current.some((c) => c.key === key) ? current : [...current, entry],
      )
      setMapping((current) => ({ ...current, [sourceKey]: entry }))
      setConfirmReplace(false)
    } catch (reason) {
      setError(desktopErrorText(reason))
    }
  }

  const execute = async (confirmed = false): Promise<void> => {
    if (preview === undefined || validationReason !== '') return
    if (effectiveMode === 'replace' && !confirmed) {
      setConfirmReplace(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const resolvedMapping: WorkspaceMapping = {}
      for (const ws of preview.sourceWorkspaces) {
        const entry = mapping[ws.key]
        if (entry !== null && entry !== undefined) {
          resolvedMapping[ws.key] = entry
        }
      }
      const res = unwrapIpc(
        await props.bridge.migration.execute({
          sourceClientId,
          targetClientId,
          selection: buildSelection(),
          mode: effectiveMode,
          mapping: resolvedMapping,
          ...(effectiveMode === 'replace'
            ? { targetScope: effectiveTargetScope, confirm: true }
            : {}),
        }),
      )
      setReport(res)
      setConfirmReplace(false)
      setStep('report')
      await props.onSuccess(res)
    } catch (reason) {
      if (isExternalChangeError(reason)) props.onExternalChange?.()
      setError(desktopErrorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const title = isRecordsMode ? t('desktop.migrate.singleTitle') : t('desktop.migrate.title')

  const footer =
    step === 'source'
      ? h(
          Fragment,
          null,
          h(
            Button,
            { variant: 'ghost', disabled: busy, onClick: props.onClose },
            t('common.cancel'),
          ),
          h(
            Button,
            {
              variant: 'primary',
              disabled:
                busy ||
                sourceClientId === '' ||
                targetClientId === '' ||
                sourceClientId === targetClientId ||
                (!isRecordsMode && scopeKind === 'workspace' && sourceWorkspaceKey === ''),
              onClick: () => {
                void runPreview()
              },
            },
            t('desktop.migrate.preview'),
          ),
        )
      : step === 'preview'
        ? h(
            'div',
            { className: 'dsh-mem-footer-split' },
            h(
              Button,
              {
                variant: 'ghost',
                disabled: busy,
                onClick: () => {
                  setConfirmReplace(false)
                  setStep('source')
                },
              },
              t('desktop.migrate.back'),
            ),
            h(
              'div',
              { className: 'dsh-mem-actions' },
              h(
                Button,
                { variant: 'ghost', disabled: busy, onClick: props.onClose },
                t('common.cancel'),
              ),
              h(
                Button,
                {
                  variant: 'primary',
                  disabled: busy || validationReason !== '',
                  onClick: () => {
                    void execute(false)
                  },
                },
                busy ? t('desktop.migrate.executing') : t('desktop.migrate.execute'),
              ),
            ),
          )
        : h(Button, { variant: 'primary', onClick: props.onClose }, t('common.close'))

  return h(
    Modal,
    {
      title,
      onClose: props.onClose,
      closeLabel: t('common.close'),
      footer,
    },
    step === 'source'
      ? h(
          'div',
          { className: 'dsh-mem-detail' },
          isRecordsMode
            ? h(
                'div',
                { className: 'dsh-mem-notice', role: 'note' },
                t('desktop.migrate.singleLockedMerge'),
              )
            : null,
          h(
            'div',
            { className: 'dsh-mem-form-grid' },
            h(
              'div',
              { className: 'dsh-mem-field' },
              h('span', { className: 'dsh-mem-label' }, t('desktop.migrate.sourceClient')),
              h(Select, {
                label: t('desktop.migrate.sourceClient'),
                value: sourceClientId,
                disabled: busy || isRecordsMode,
                options: props.clients.map((c) => ({ value: c.id, label: c.name })),
                onChange: setSourceClientId,
              }),
            ),
            h(
              'div',
              { className: 'dsh-mem-field' },
              h('span', { className: 'dsh-mem-label' }, t('desktop.migrate.targetClient')),
              h(Select, {
                label: t('desktop.migrate.targetClient'),
                value: targetClientId,
                disabled: busy || candidateTargets.length === 0,
                options: candidateTargets.map((c) => ({ value: c.id, label: c.name })),
                onChange: setTargetClientId,
              }),
            ),
          ),
          isRecordsMode
            ? null
            : h(
                Fragment,
                null,
                h(
                  'div',
                  { className: 'dsh-mem-form-grid' },
                  h(
                    'div',
                    { className: 'dsh-mem-field' },
                    h('span', { className: 'dsh-mem-label' }, t('desktop.migrate.sourceScope')),
                    h(Select, {
                      label: t('desktop.migrate.sourceScope'),
                      value: scopeKind,
                      disabled: busy,
                      options: [
                        { value: 'all', label: t('desktop.migrate.scopeAll') },
                        { value: 'global', label: t('desktop.migrate.scopeGlobal') },
                        { value: 'workspace', label: t('desktop.migrate.scopeWorkspace') },
                      ],
                      onChange: (v) =>
                        setScopeKind(v === 'global' || v === 'workspace' ? v : 'all'),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-field' },
                    h('span', { className: 'dsh-mem-label' }, t('desktop.migrate.mode')),
                    h(Select, {
                      label: t('desktop.migrate.mode'),
                      value: mode,
                      disabled: busy,
                      options: [
                        { value: 'merge', label: t('desktop.migrate.modeMerge') },
                        { value: 'replace', label: t('desktop.migrate.modeReplace') },
                      ],
                      onChange: (v) => setMode(v === 'replace' ? 'replace' : 'merge'),
                    }),
                  ),
                ),
                scopeKind === 'workspace'
                  ? h(
                      'div',
                      { className: 'dsh-mem-field' },
                      h('span', { className: 'dsh-mem-label' }, t('filter.workspace')),
                      h(Select, {
                        label: t('filter.workspace'),
                        value: sourceWorkspaceKey,
                        disabled: busy || sourceWorkspacesList.length === 0,
                        options: sourceWorkspacesList.map((w) => ({
                          value: w.key,
                          label: `${w.root} (${w.memoryCount})`,
                        })),
                        onChange: setSourceWorkspaceKey,
                      }),
                    )
                  : null,
                h(Switch, {
                  label: t('desktop.migrate.includeArchived'),
                  checked: includeArchived,
                  disabled: busy,
                  onChange: setIncludeArchived,
                }),
                h(Switch, {
                  label: t('desktop.migrate.includeEpisodes'),
                  checked: includeEpisodes,
                  disabled: busy,
                  onChange: setIncludeEpisodes,
                }),
              ),
          error !== '' ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, error) : null,
        )
      : step === 'preview' && preview !== undefined
        ? h(
            'div',
            { className: 'dsh-mem-detail' },
            h(
              'dl',
              { className: 'dsh-mem-facts' },
              h(
                'div',
                { className: 'dsh-mem-fact' },
                h('dt', null, t('desktop.migrate.memoryCount')),
                h('dd', null, String(preview.memoryCount)),
              ),
              h(
                'div',
                { className: 'dsh-mem-fact' },
                h('dt', null, t('desktop.migrate.episodeCount')),
                h('dd', null, String(preview.episodeCount)),
              ),
              h(
                'div',
                { className: 'dsh-mem-fact' },
                h('dt', null, t('desktop.migrate.mode')),
                h(
                  'dd',
                  null,
                  effectiveMode === 'replace'
                    ? t('desktop.migrate.modeReplace')
                    : t('desktop.migrate.modeMerge'),
                ),
              ),
            ),
            !isRecordsMode && preview.allowReplace
              ? h(
                  'div',
                  { className: 'dsh-mem-setting-row' },
                  h(
                    'span',
                    { className: 'dsh-mem-switchtext' },
                    h('span', { className: 'dsh-mem-switchlabel' }, t('desktop.migrate.mode')),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mem-setting-control' },
                    h(Select, {
                      label: t('desktop.migrate.mode'),
                      value: mode,
                      disabled: busy,
                      options: [
                        { value: 'merge', label: t('desktop.migrate.modeMerge') },
                        { value: 'replace', label: t('desktop.migrate.modeReplace') },
                      ],
                      onChange: (v) => {
                        setMode(v === 'replace' ? 'replace' : 'merge')
                        setConfirmReplace(false)
                      },
                    }),
                  ),
                )
              : null,
            effectiveMode === 'replace'
              ? h(
                  'div',
                  { className: 'dsh-mem-form-grid' },
                  h(
                    'div',
                    { className: 'dsh-mem-field' },
                    h('span', { className: 'dsh-mem-label' }, t('desktop.migrate.targetScope')),
                    h(Select, {
                      label: t('desktop.migrate.targetScope'),
                      value: targetScopeKind,
                      disabled: busy,
                      options: [
                        { value: 'all', label: t('desktop.migrate.targetScopeAll') },
                        { value: 'global', label: t('desktop.migrate.targetScopeGlobal') },
                        ...(allTargetWorkspaceChoices.length > 0
                          ? [
                              {
                                value: 'workspace',
                                label: t('desktop.migrate.targetScopeWorkspace'),
                              },
                            ]
                          : []),
                      ],
                      onChange: (v) => {
                        setTargetScopeKind(v === 'global' || v === 'workspace' ? v : 'all')
                        setConfirmReplace(false)
                      },
                    }),
                  ),
                  targetScopeKind === 'workspace'
                    ? h(
                        'div',
                        { className: 'dsh-mem-field' },
                        h('span', { className: 'dsh-mem-label' }, t('filter.workspace')),
                        h(Select, {
                          label: t('filter.workspace'),
                          value: targetScopeWorkspaceKey,
                          disabled: busy,
                          options: allTargetWorkspaceChoices.map((w) => ({
                            value: w.key,
                            label: w.root,
                          })),
                          onChange: (v) => {
                            setTargetScopeWorkspaceKey(v)
                            setConfirmReplace(false)
                          },
                        }),
                      )
                    : null,
                )
              : null,
            preview.sourceWorkspaces.length > 0
              ? h(
                  'div',
                  { className: 'dsh-mem-mapping' },
                  h('span', { className: 'dsh-mem-label' }, t('desktop.migrate.mappingTitle')),
                  h('p', { className: 'dsh-mem-hint' }, t('desktop.migrate.mappingHint')),
                  ...preview.sourceWorkspaces.map((ws) => {
                    const currentTarget = mapping[ws.key]
                    return h(
                      'div',
                      { key: ws.key, className: 'memloom-wizard-map-row' },
                      h(Tag, null, `${ws.root} (${ws.count})`),
                      h(Select, {
                        label: `${ws.key}: ${t('desktop.migrate.mappingTitle')}`,
                        value: currentTarget?.key ?? '',
                        disabled: busy,
                        options: [
                          { value: '', label: t('desktop.migrate.mappingSkip') },
                          ...allTargetWorkspaceChoices.map((choice) => ({
                            value: choice.key,
                            label: choice.root,
                          })),
                        ],
                        onChange: (value) => {
                          setConfirmReplace(false)
                          if (value === '') {
                            setMapping((cur) => ({ ...cur, [ws.key]: null }))
                          } else {
                            const found = allTargetWorkspaceChoices.find((c) => c.key === value)
                            if (found !== undefined) {
                              setMapping((cur) => ({ ...cur, [ws.key]: found }))
                            }
                          }
                        },
                      }),
                      h(
                        Button,
                        {
                          size: 'sm',
                          disabled: busy,
                          onClick: () => {
                            void pickDirectoryForWorkspace(ws.key)
                          },
                        },
                        t('desktop.migrate.pickDir'),
                      ),
                    )
                  }),
                )
              : null,
            validationReason !== ''
              ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, validationReason)
              : null,
            confirmReplace
              ? h(
                  'div',
                  { className: 'dsh-mem-confirm', role: 'alert' },
                  h(
                    'span',
                    null,
                    formatMessage('desktop.migrate.replaceConfirmWarning', {
                      scope: scopeLabel(effectiveTargetScope),
                    }),
                  ),
                  h(
                    Button,
                    {
                      variant: 'danger',
                      size: 'sm',
                      disabled: busy,
                      onClick: () => {
                        void execute(true)
                      },
                    },
                    t('desktop.migrate.confirmExecute'),
                  ),
                  h(
                    Button,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      disabled: busy,
                      onClick: () => setConfirmReplace(false),
                    },
                    t('common.cancel'),
                  ),
                )
              : null,
            error !== '' ? h('div', { className: 'dsh-mem-confirm', role: 'alert' }, error) : null,
          )
        : report !== undefined
          ? h(
              'div',
              { className: 'dsh-mem-report', role: 'status' },
              h('strong', null, t('desktop.migrate.reportTitle')),
              h(
                'p',
                null,
                formatMessage('transfer.report', {
                  created: report.created,
                  skipped: report.skipped,
                  replaced: report.replaced,
                }),
              ),
              h(
                'p',
                null,
                formatMessage('desktop.migrate.episodesImported', {
                  count: report.episodesImported,
                }),
              ),
              h(
                'p',
                null,
                formatMessage('desktop.migrate.redactedCount', { count: report.redacted }),
              ),
              report.unmapped.length > 0
                ? h('p', null, `${t('transfer.unmapped')} ${report.unmapped.join(', ')}`)
                : null,
              report.errors.length > 0
                ? h(
                    'p',
                    null,
                    `${t('transfer.errors')} ${report.errors.map((e) => e.message).join('; ')}`,
                  )
                : null,
            )
          : null,
  )
}
