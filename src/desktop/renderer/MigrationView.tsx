/**
 * Full-page Cross-Host Migration Workbench (DSH <-> AGY) featuring the
 * Loom Weft Bridge selector and strict Replace safety enforcement.
 * @module memloom/desktop/renderer/MigrationView
 */
import * as React from 'react'
import { formatMessage, t } from '../../client/locales.ts'
import type { WorkspaceSummary } from '../../core/engine.ts'
import type { ExportScope, ImportReport, WorkspaceMapping } from '../../core/exchange.ts'
import type { DesktopBridgeApi } from '../ipc-contract.ts'
import type {
  DesktopClientInfo,
  MigrationPreviewResult,
  MigrationSourceSelection,
} from '../multi-service.ts'
import { desktopErrorText, isExternalChangeError, unwrapIpc } from './desktop-locales.ts'
import {
  Button,
  Checkbox,
  Dropdown,
  HostLogo,
  Icons,
  Modal,
  SegmentedControl,
  Switch,
} from './ui.tsx'

const h = React.createElement

export interface MigrationViewProps {
  readonly bridge: DesktopBridgeApi
  readonly clients: readonly DesktopClientInfo[]
  readonly initialSourceClientId?: string
  readonly initialTargetClientId?: string
  readonly initialSelection?: MigrationSourceSelection
  readonly banners?: React.ReactNode
  readonly onSuccess: (report: ImportReport) => Promise<void>
  readonly onExternalChange: () => void
  readonly onOpenTargetHost: (clientId: string) => void
  readonly onClearSelection: () => void
  readonly onNotify: (message: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void
}

type ScopeKind = 'all' | 'global' | 'workspace'
type TargetScopeKind = 'all' | 'global' | 'workspace'

function normalizeWorkspaceKey(rawRoot: string): string {
  return rawRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function scopeLabel(scope: ExportScope): string {
  if (scope === 'all') return t('desktop.migrate.targetScopeAll')
  if (scope === 'global') return t('desktop.migrate.targetScopeGlobal')
  return scope.workspaceKey
}

export function MigrationView(props: MigrationViewProps): React.ReactElement {
  const { bridge, clients } = props
  const isRecordsMode = props.initialSelection?.kind === 'records'

  const readySources = React.useMemo(
    () => clients.filter((c) => c.enabled && c.health === 'ready'),
    [clients],
  )
  const [sourceClientId, setSourceClientId] = React.useState<string>(
    () => props.initialSourceClientId ?? readySources[0]?.id ?? clients[0]?.id ?? '',
  )

  const candidateTargets = React.useMemo(
    () => clients.filter((c) => c.id !== sourceClientId),
    [clients, sourceClientId],
  )

  const [targetClientId, setTargetClientId] = React.useState<string>(() => {
    if (
      props.initialTargetClientId !== undefined &&
      props.initialTargetClientId !== sourceClientId
    ) {
      return props.initialTargetClientId
    }
    const writable = candidateTargets.find(
      (c) => c.writable && c.health !== 'corrupted' && c.health !== 'unreadable',
    )
    return writable?.id ?? candidateTargets[0]?.id ?? ''
  })

  React.useEffect(() => {
    if (props.initialSourceClientId !== undefined) {
      setSourceClientId(props.initialSourceClientId)
    }
  }, [props.initialSourceClientId])

  React.useEffect(() => {
    if (
      targetClientId === sourceClientId ||
      !candidateTargets.some((c) => c.id === targetClientId)
    ) {
      const writable = candidateTargets.find((c) => c.writable && c.health !== 'corrupted')
      setTargetClientId(writable?.id ?? candidateTargets[0]?.id ?? '')
    }
  }, [sourceClientId, targetClientId, candidateTargets])

  const [step, setStep] = React.useState<'1' | '2' | '3'>('1')
  const [sourceWorkspacesList, setSourceWorkspacesList] = React.useState<WorkspaceSummary[]>([])
  const [scopeKind, setScopeKind] = React.useState<ScopeKind>('all')
  const [sourceWorkspaceKey, setSourceWorkspaceKey] = React.useState<string>('')
  const [includeArchived, setIncludeArchived] = React.useState(true)
  const [includeEpisodes, setIncludeEpisodes] = React.useState(true)
  const [mode, setMode] = React.useState<'merge' | 'replace'>('merge')

  const [preview, setPreview] = React.useState<MigrationPreviewResult | undefined>(undefined)
  const [mapping, setMapping] = React.useState<
    Record<string, { key: string; root: string } | null>
  >({})
  const [customTargets, setCustomTargets] = React.useState<Array<{ key: string; root: string }>>([])
  const [targetScopeKind, setTargetScopeKind] = React.useState<TargetScopeKind>('all')
  const [targetScopeWorkspaceKey, setTargetScopeWorkspaceKey] = React.useState<string>('')
  const [confirmReplaceOpen, setConfirmReplaceOpen] = React.useState(false)
  const [replaceAck, setReplaceAck] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [report, setReport] = React.useState<ImportReport | undefined>(undefined)

  const sourceWorkspaceKeyRef = React.useRef(sourceWorkspaceKey)
  sourceWorkspaceKeyRef.current = sourceWorkspaceKey

  React.useEffect(() => {
    if (isRecordsMode || sourceClientId === '') {
      setSourceWorkspacesList([])
      return undefined
    }
    let cancelled = false
    void bridge.memory
      .listWorkspaces({ clientId: sourceClientId })
      .then((res) => {
        if (cancelled) return
        const list = unwrapIpc(res)
        setSourceWorkspacesList(list)
        if (list.length > 0 && !list.some((w) => w.key === sourceWorkspaceKeyRef.current)) {
          setSourceWorkspaceKey(list[0]!.key)
        }
      })
      .catch(() => {
        if (!cancelled) setSourceWorkspacesList([])
      })
    return () => {
      cancelled = true
    }
  }, [bridge, sourceClientId, isRecordsMode])

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
    return { kind: 'scope', scope, includeArchived, includeEpisodes }
  }

  const runPreview = async (nextStep: '2' | '3' = '2'): Promise<void> => {
    if (sourceClientId === '' || targetClientId === '' || sourceClientId === targetClientId) {
      setError(t('desktop.migrate.sameClientError'))
      return
    }
    setBusy(true)
    setError('')
    setReport(undefined)
    try {
      const res = unwrapIpc(
        await bridge.migration.preview({
          sourceClientId,
          targetClientId,
          selection: buildSelection(),
        }),
      )
      setPreview(res)
      const initialMap: Record<string, { key: string; root: string } | null> = {}
      const extraTargets: Array<{ key: string; root: string }> = []
      const knownKeys = new Set(res.targetWorkspaces.map((w) => w.key))
      for (const ws of res.sourceWorkspaces) {
        const suggested = res.suggestedMapping[ws.key]
        if (suggested !== undefined) {
          initialMap[ws.key] = suggested
          if (!knownKeys.has(suggested.key)) {
            knownKeys.add(suggested.key)
            extraTargets.push(suggested)
          }
        } else {
          initialMap[ws.key] = null
        }
      }
      setMapping(initialMap)
      setCustomTargets(extraTargets)
      if (!res.allowReplace && mode === 'replace') setMode('merge')
      const firstWs = res.targetWorkspaces[0]?.key ?? res.sourceWorkspaces[0]?.key ?? ''
      setTargetScopeWorkspaceKey(firstWs)
      setTargetScopeKind('all')
      setStep(nextStep)
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      setError(desktopErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const allTargetChoices = React.useMemo(() => {
    const map = new Map<string, { key: string; root: string }>()
    for (const ws of preview?.targetWorkspaces ?? []) {
      map.set(ws.key, { key: ws.key, root: ws.root })
    }
    for (const ct of customTargets) {
      if (!map.has(ct.key)) map.set(ct.key, ct)
    }
    return [...map.values()]
  }, [preview, customTargets])

  const effectiveMode: 'merge' | 'replace' = isRecordsMode ? 'merge' : mode
  const effectiveTargetScope: ExportScope =
    targetScopeKind === 'all'
      ? 'all'
      : targetScopeKind === 'global'
        ? 'global'
        : { workspaceKey: targetScopeWorkspaceKey }

  const hasSkippedWorkspace =
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
        : effectiveMode === 'replace' && hasSkippedWorkspace
          ? t('desktop.migrate.replaceNoSkipError')
          : effectiveMode === 'replace' && hasOutOfScopeMapping
            ? t('desktop.migrate.replaceScopeError')
            : ''

  const pickDirectoryForWorkspace = async (sourceKey: string): Promise<void> => {
    setError('')
    try {
      const dir = unwrapIpc(await bridge.dialog.pickDirectory())
      if (dir === null || dir === '') return
      const key = normalizeWorkspaceKey(dir)
      const entry = { key, root: dir }
      setCustomTargets((cur) => (cur.some((c) => c.key === key) ? cur : [...cur, entry]))
      setMapping((cur) => ({ ...cur, [sourceKey]: entry }))
    } catch (err) {
      setError(desktopErrorText(err))
    }
  }

  const execute = async (confirmed = false): Promise<void> => {
    if (preview === undefined || validationReason !== '') return
    if (effectiveMode === 'replace' && !confirmed) {
      setConfirmReplaceOpen(true)
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
        await bridge.migration.execute({
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
      setConfirmReplaceOpen(false)
      setReport(res)
      setStep('3')
      await props.onSuccess(res)
      props.onNotify(
        formatMessage('transfer.report', {
          created: res.created,
          skipped: res.skipped,
          replaced: res.replaced,
        }),
        'success',
      )
    } catch (err) {
      if (isExternalChangeError(err)) props.onExternalChange()
      setError(desktopErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const srcClient = clients.find((c) => c.id === sourceClientId)
  const dstClient = clients.find((c) => c.id === targetClientId)
  const hostOptions = clients.map((c) => ({
    value: c.id,
    label: c.name,
    icon: h(HostLogo, { kind: c.kind, size: 15 }),
  }))

  const swapHosts = (): void => {
    if (targetClientId === '' || sourceClientId === '') return
    const nextSrc = targetClientId
    const nextDst = sourceClientId
    setSourceClientId(nextSrc)
    setTargetClientId(nextDst)
    setPreview(undefined)
    setReport(undefined)
    setStep('1')
  }

  return h(
    React.Fragment,
    null,
    h(
      'header',
      { className: 'ml-stage-header' },
      h(
        'div',
        { className: 'ml-stage-title-group' },
        h('h1', { className: 'ml-stage-title' }, t('desktop.nav.migrate')),
        h('p', { className: 'ml-stage-subtitle' }, t('desktop.transfer.wizardDesc')),
      ),
    ),

    props.banners ?? null,

    h(
      'div',
      { className: 'ml-scroll-canvas ml-scroll' },
      h(
        'div',
        { className: 'ml-canvas-container' },

        // Signature Loom Weft Bridge
        h(
          'div',
          { className: 'ml-weft-bridge' },
          h(
            'div',
            { className: 'ml-bridge-node' },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '12px',
                  color: 'var(--ml-text-muted)',
                },
              },
              h('span', null, t('desktop.migrate.sourceClient')),
              h('span', { className: 'ml-mono' }, srcClient?.format ?? '—'),
            ),
            h(Dropdown, {
              label: t('desktop.migrate.sourceClient'),
              value: sourceClientId,
              options: hostOptions,
              disabled: isRecordsMode || busy,
              fullWidth: true,
              onChange: (v) => {
                setSourceClientId(v)
                setPreview(undefined)
                setReport(undefined)
                setStep('1')
              },
            }),
          ),

          h(
            'div',
            { className: 'ml-bridge-track' },
            h('div', { className: 'ml-bridge-line' }),
            h(
              Button,
              {
                className: 'ml-bridge-swap',
                disabled: isRecordsMode || busy,
                title: t('desktop.migrate.title'),
                onClick: swapHosts,
              },
              Icons.migrate(),
            ),
          ),

          h(
            'div',
            { className: 'ml-bridge-node' },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } },
              h(
                'span',
                { style: { color: 'var(--ml-text-muted)' } },
                t('desktop.migrate.targetClient'),
              ),
              h(
                'span',
                {
                  style: {
                    color: dstClient?.writable ? 'var(--ml-success)' : 'var(--ml-warn)',
                    fontWeight: 500,
                  },
                },
                dstClient?.writable ? t('desktop.status.writable') : t('desktop.status.readonly'),
              ),
            ),
            h(Dropdown, {
              label: t('desktop.migrate.targetClient'),
              value: targetClientId,
              options: hostOptions,
              disabled: busy,
              fullWidth: true,
              onChange: (v) => {
                setTargetClientId(v)
                setPreview(undefined)
                setReport(undefined)
                setStep('1')
              },
            }),
          ),
        ),

        isRecordsMode
          ? h(
              'div',
              {
                className: 'ml-banner',
                'data-tone': 'info',
                style: { borderRadius: '10px', border: '1px solid var(--ml-copper-border)' },
              },
              h('span', null, t('desktop.migrate.singleLockedMerge')),
              h(Button, { size: 'sm', onClick: props.onClearSelection }, t('common.clear')),
            )
          : null,

        error !== ''
          ? h(
              'div',
              {
                className: 'ml-banner',
                'data-tone': 'danger',
                role: 'alert',
                style: { borderRadius: '10px', border: '1px solid var(--ml-danger-border)' },
              },
              error,
            )
          : null,

        // Sequential 3-step segmented bar
        h(SegmentedControl<'1' | '2' | '3'>, {
          label: t('desktop.migrate.title'),
          fullWidth: true,
          value: step,
          onChange: (next) => {
            if (next === '1') setStep('1')
            else if (next === '2') {
              if (preview === undefined) void runPreview('2')
              else setStep('2')
            } else if (next === '3') {
              if (preview === undefined) void runPreview('3')
              else setStep('3')
            }
          },
          items: [
            { id: '1', label: `01 ${t('desktop.migrate.sourceScope')}` },
            { id: '2', label: `02 ${t('desktop.migrate.mappingTitle')}` },
            { id: '3', label: `03 ${t('desktop.migrate.reportTitle')}` },
          ],
        }),

        // Step Panel
        h(
          'div',
          {
            className: 'ml-surface-card',
            style: { padding: '22px', display: 'flex', flexDirection: 'column', gap: '18px' },
          },
          step === '1'
            ? h(
                React.Fragment,
                null,
                !isRecordsMode
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        {
                          style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                            gap: '12px',
                          },
                        },
                        (
                          [
                            { id: 'all', title: t('desktop.migrate.scopeAll') },
                            { id: 'workspace', title: t('desktop.migrate.scopeWorkspace') },
                            { id: 'global', title: t('desktop.migrate.scopeGlobal') },
                          ] as const
                        ).map((opt) => {
                          const selected = scopeKind === opt.id
                          return h(
                            'button',
                            {
                              key: opt.id,
                              type: 'button',
                              onClick: () => {
                                setScopeKind(opt.id)
                                setPreview(undefined)
                                setReport(undefined)
                              },
                              style: {
                                padding: '14px',
                                borderRadius: '10px',
                                border: 0,
                                textAlign: 'left',
                                cursor: 'pointer',
                                font: 'inherit',
                                background: selected ? 'var(--ml-recessed)' : 'var(--ml-panel-bg)',
                                color: 'var(--ml-text-primary)',
                                boxShadow: selected
                                  ? 'inset 0 0 0 1.5px var(--ml-copper)'
                                  : 'inset 0 0 0 1px var(--ml-border)',
                              },
                            },
                            h('div', { style: { fontSize: '13px', fontWeight: 500 } }, opt.title),
                          )
                        }),
                      ),
                      scopeKind === 'workspace' && sourceWorkspacesList.length > 0
                        ? h(Dropdown, {
                            label: t('desktop.migrate.scopeWorkspace'),
                            value: sourceWorkspaceKey,
                            options: sourceWorkspacesList.map((w) => ({
                              value: w.key,
                              label: w.root,
                            })),
                            fullWidth: true,
                            onChange: (v) => {
                              setSourceWorkspaceKey(v)
                              setPreview(undefined)
                              setReport(undefined)
                            },
                          })
                        : null,
                      h(
                        'div',
                        { style: { borderTop: '1px solid var(--ml-border)', paddingTop: '6px' } },
                        h(Switch, {
                          label: t('desktop.migrate.includeArchived'),
                          checked: includeArchived,
                          onChange: (v) => {
                            setIncludeArchived(v)
                            setPreview(undefined)
                            setReport(undefined)
                          },
                        }),
                        h(Switch, {
                          label: t('desktop.migrate.includeEpisodes'),
                          checked: includeEpisodes,
                          onChange: (v) => {
                            setIncludeEpisodes(v)
                            setPreview(undefined)
                            setReport(undefined)
                          },
                        }),
                      ),
                    )
                  : h(
                      'div',
                      { style: { fontSize: '13px', color: 'var(--ml-text-secondary)' } },
                      formatMessage('desktop.inspector.selectedBatch', {
                        count:
                          props.initialSelection?.kind === 'records'
                            ? props.initialSelection.memoryIds.length
                            : 0,
                      }),
                    ),
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      justifyContent: 'flex-end',
                      borderTop: '1px solid var(--ml-border)',
                      paddingTop: '14px',
                    },
                  },
                  h(
                    Button,
                    { variant: 'primary', disabled: busy, onClick: () => void runPreview('2') },
                    t('desktop.migrate.preview'),
                  ),
                ),
              )
            : step === '2'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { style: { fontSize: '14px', fontWeight: 600 } },
                    t('desktop.migrate.mappingTitle'),
                  ),
                  preview === undefined || preview.sourceWorkspaces.length === 0
                    ? h(
                        'div',
                        { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                        t('desktop.migrate.mappingHint'),
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                        preview.sourceWorkspaces.map((ws) => {
                          const cur = mapping[ws.key]
                          const curVal = cur === null || cur === undefined ? '__skip__' : cur.key
                          const opts = [
                            { value: '__skip__', label: t('desktop.migrate.mappingSkip') },
                            ...allTargetChoices.map((c) => ({ value: c.key, label: c.root })),
                          ]
                          return h(
                            'div',
                            {
                              key: ws.key,
                              style: {
                                padding: '12px 14px',
                                borderRadius: '10px',
                                background: 'var(--ml-panel-bg)',
                                boxShadow: 'inset 0 0 0 1px var(--ml-border)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '12px',
                              },
                            },
                            h(
                              'div',
                              { style: { minWidth: 0 } },
                              h('div', { style: { fontSize: '12px', fontWeight: 500 } }, ws.root),
                              h(
                                'div',
                                {
                                  className: 'ml-mono',
                                  style: { fontSize: '12px', color: 'var(--ml-text-muted)' },
                                },
                                `${ws.count}`,
                              ),
                            ),
                            h(
                              'div',
                              { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                              h(Dropdown, {
                                label: `${ws.key}: ${t('desktop.migrate.mappingTitle')}`,
                                value: curVal,
                                options: opts,
                                onChange: (val) => {
                                  if (val === '__skip__') {
                                    setMapping((prev) => ({ ...prev, [ws.key]: null }))
                                  } else {
                                    const found = allTargetChoices.find((c) => c.key === val)
                                    if (found !== undefined) {
                                      setMapping((prev) => ({ ...prev, [ws.key]: found }))
                                    }
                                  }
                                },
                              }),
                              h(
                                Button,
                                {
                                  size: 'sm',
                                  onClick: () => void pickDirectoryForWorkspace(ws.key),
                                },
                                t('desktop.migrate.pickDir'),
                              ),
                            ),
                          )
                        }),
                      ),

                  !isRecordsMode
                    ? h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                        h(
                          'div',
                          { style: { fontSize: '14px', fontWeight: 600 } },
                          t('desktop.migrate.mode'),
                        ),
                        h(
                          'div',
                          {
                            style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
                          },
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => {
                                setMode('merge')
                                setReplaceAck(false)
                              },
                              style: {
                                padding: '14px',
                                borderRadius: '10px',
                                border: 0,
                                textAlign: 'left',
                                cursor: 'pointer',
                                font: 'inherit',
                                background:
                                  effectiveMode === 'merge'
                                    ? 'var(--ml-recessed)'
                                    : 'var(--ml-panel-bg)',
                                color: 'var(--ml-text-primary)',
                                boxShadow:
                                  effectiveMode === 'merge'
                                    ? 'inset 0 0 0 1.5px var(--ml-copper)'
                                    : 'inset 0 0 0 1px var(--ml-border)',
                              },
                            },
                            h(
                              'div',
                              { style: { fontSize: '13px', fontWeight: 500 } },
                              t('desktop.migrate.modeMerge'),
                            ),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              disabled: preview?.allowReplace === false,
                              onClick: () => {
                                setMode('replace')
                                setReplaceAck(false)
                              },
                              style: {
                                padding: '14px',
                                borderRadius: '10px',
                                border: 0,
                                textAlign: 'left',
                                cursor: preview?.allowReplace === false ? 'not-allowed' : 'pointer',
                                font: 'inherit',
                                background:
                                  effectiveMode === 'replace'
                                    ? 'var(--ml-danger-soft)'
                                    : 'var(--ml-panel-bg)',
                                color:
                                  effectiveMode === 'replace'
                                    ? 'var(--ml-danger)'
                                    : 'var(--ml-text-primary)',
                                boxShadow:
                                  effectiveMode === 'replace'
                                    ? 'inset 0 0 0 1.5px var(--ml-danger)'
                                    : 'inset 0 0 0 1px var(--ml-border)',
                              },
                            },
                            h(
                              'div',
                              { style: { fontSize: '13px', fontWeight: 500 } },
                              t('desktop.migrate.modeReplace'),
                            ),
                          ),
                        ),
                        effectiveMode === 'replace'
                          ? h(
                              'div',
                              {
                                style: {
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '10px',
                                  padding: '12px 14px',
                                  borderRadius: '10px',
                                  background: 'var(--ml-danger-soft)',
                                  boxShadow: 'inset 0 0 0 1px var(--ml-danger-border)',
                                },
                              },
                              h(
                                'div',
                                {
                                  style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '12px',
                                  },
                                },
                                h(
                                  'span',
                                  { style: { fontSize: '12px', color: 'var(--ml-danger)' } },
                                  t('desktop.migrate.targetScope'),
                                ),
                                h(Dropdown, {
                                  label: t('desktop.migrate.targetScope'),
                                  value: targetScopeKind,
                                  options: [
                                    { value: 'all', label: t('desktop.migrate.targetScopeAll') },
                                    {
                                      value: 'global',
                                      label: t('desktop.migrate.targetScopeGlobal'),
                                    },
                                    ...(allTargetChoices.length > 0
                                      ? [
                                          {
                                            value: 'workspace',
                                            label: t('desktop.migrate.targetScopeWorkspace'),
                                          },
                                        ]
                                      : []),
                                  ],
                                  onChange: (v) => setTargetScopeKind(v as TargetScopeKind),
                                }),
                              ),
                              targetScopeKind === 'workspace' && allTargetChoices.length > 0
                                ? h(Dropdown, {
                                    label: t('desktop.migrate.targetScopeWorkspace'),
                                    value: targetScopeWorkspaceKey,
                                    options: allTargetChoices.map((c) => ({
                                      value: c.key,
                                      label: c.root,
                                    })),
                                    fullWidth: true,
                                    onChange: setTargetScopeWorkspaceKey,
                                  })
                                : null,
                              h(
                                'div',
                                {
                                  style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '10px',
                                  },
                                },
                                h(
                                  'span',
                                  { style: { fontSize: '12px', color: 'var(--ml-danger)' } },
                                  formatMessage('desktop.migrate.replaceConfirmWarning', {
                                    scope: scopeLabel(effectiveTargetScope),
                                  }),
                                ),
                                h(
                                  'div',
                                  {
                                    style: {
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '8px',
                                      flex: 'none',
                                    },
                                  },
                                  h(Checkbox, {
                                    checked: replaceAck,
                                    label: t('common.confirm'),
                                    onChange: setReplaceAck,
                                  }),
                                  h(
                                    'span',
                                    { style: { fontSize: '12px', fontWeight: 500 } },
                                    t('common.confirm'),
                                  ),
                                ),
                              ),
                            )
                          : null,
                      )
                    : null,

                  validationReason !== ''
                    ? h(
                        'div',
                        {
                          className: 'ml-banner',
                          'data-tone': 'danger',
                          role: 'alert',
                          style: { borderRadius: '8px' },
                        },
                        validationReason,
                      )
                    : null,

                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        borderTop: '1px solid var(--ml-border)',
                        paddingTop: '14px',
                      },
                    },
                    h(Button, { onClick: () => setStep('1') }, t('desktop.migrate.back')),
                    h(
                      Button,
                      {
                        variant: 'primary',
                        disabled:
                          validationReason !== '' || (effectiveMode === 'replace' && !replaceAck),
                        onClick: () => setStep('3'),
                      },
                      t('desktop.migrate.preview'),
                    ),
                  ),
                )
              : report !== undefined
                ? h(
                    'div',
                    {
                      style: {
                        padding: '16px 0',
                        textAlign: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '10px',
                      },
                    },
                    h(
                      'div',
                      {
                        style: {
                          width: '42px',
                          height: '42px',
                          borderRadius: '999px',
                          background: 'var(--ml-success)',
                          color: '#fff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        },
                      },
                      Icons.check(),
                    ),
                    h(
                      'div',
                      { style: { fontSize: '15px', fontWeight: 600 } },
                      t('desktop.migrate.reportTitle'),
                    ),
                    h(
                      'p',
                      { style: { margin: 0, fontSize: '13px', color: 'var(--ml-text-secondary)' } },
                      formatMessage('transfer.report', {
                        created: report.created,
                        skipped: report.skipped,
                        replaced: report.replaced,
                      }),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                      h(
                        Button,
                        {
                          variant: 'primary',
                          onClick: () => props.onOpenTargetHost(targetClientId),
                        },
                        t('desktop.aggregate.openInClient'),
                      ),
                      h(
                        Button,
                        {
                          onClick: () => {
                            setReport(undefined)
                            setStep('1')
                          },
                        },
                        t('common.refresh'),
                      ),
                    ),
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { style: { fontSize: '14px', fontWeight: 600 } },
                      t('desktop.migrate.title'),
                    ),
                    h(
                      'div',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                          gap: '12px',
                        },
                      },
                      h(
                        'div',
                        {
                          style: {
                            padding: '14px',
                            borderRadius: '10px',
                            background: 'var(--ml-panel-bg)',
                            boxShadow: 'inset 0 0 0 1px var(--ml-border)',
                          },
                        },
                        h(
                          'div',
                          { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                          t('desktop.migrate.memoryCount'),
                        ),
                        h(
                          'div',
                          {
                            className: 'ml-tabular',
                            style: { fontSize: '18px', fontWeight: 600, marginTop: '4px' },
                          },
                          String(preview?.memoryCount ?? 0),
                        ),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            padding: '14px',
                            borderRadius: '10px',
                            background: 'var(--ml-panel-bg)',
                            boxShadow: 'inset 0 0 0 1px var(--ml-border)',
                          },
                        },
                        h(
                          'div',
                          { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                          t('desktop.migrate.episodeCount'),
                        ),
                        h(
                          'div',
                          {
                            className: 'ml-tabular',
                            style: { fontSize: '18px', fontWeight: 600, marginTop: '4px' },
                          },
                          String(preview?.episodeCount ?? 0),
                        ),
                      ),
                      h(
                        'div',
                        {
                          style: {
                            padding: '14px',
                            borderRadius: '10px',
                            background: 'var(--ml-panel-bg)',
                            boxShadow: 'inset 0 0 0 1px var(--ml-border)',
                          },
                        },
                        h(
                          'div',
                          { style: { fontSize: '12px', color: 'var(--ml-text-muted)' } },
                          t('desktop.migrate.mode'),
                        ),
                        h(
                          'div',
                          { style: { fontSize: '15px', fontWeight: 600, marginTop: '6px' } },
                          effectiveMode === 'merge'
                            ? t('desktop.migrate.modeMerge')
                            : t('desktop.migrate.modeReplace'),
                        ),
                      ),
                    ),
                    validationReason !== ''
                      ? h(
                          'div',
                          {
                            className: 'ml-banner',
                            'data-tone': 'danger',
                            role: 'alert',
                            style: { borderRadius: '8px' },
                          },
                          validationReason,
                        )
                      : null,
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          justifyContent: 'space-between',
                          borderTop: '1px solid var(--ml-border)',
                          paddingTop: '14px',
                        },
                      },
                      h(
                        Button,
                        { disabled: busy, onClick: () => setStep('2') },
                        t('desktop.migrate.back'),
                      ),
                      h(
                        Button,
                        {
                          variant: effectiveMode === 'replace' ? 'danger' : 'primary',
                          disabled: busy || validationReason !== '',
                          onClick: () => void execute(false),
                        },
                        busy ? t('desktop.migrate.executing') : t('desktop.migrate.execute'),
                      ),
                    ),
                  ),
        ),
      ),
    ),

    confirmReplaceOpen
      ? h(
          Modal,
          {
            title: t('desktop.migrate.modeReplace'),
            closeLabel: t('common.close'),
            maxWidth: 460,
            onClose: () => setConfirmReplaceOpen(false),
            footer: h(
              React.Fragment,
              null,
              h(
                Button,
                { disabled: busy, onClick: () => setConfirmReplaceOpen(false) },
                t('common.cancel'),
              ),
              h(
                Button,
                { variant: 'danger', disabled: busy, onClick: () => void execute(true) },
                t('desktop.migrate.confirmExecute'),
              ),
            ),
          },
          h(
            'p',
            { style: { margin: 0, fontSize: '13px', color: 'var(--ml-danger)', lineHeight: 1.6 } },
            formatMessage('desktop.migrate.replaceConfirmWarning', {
              scope: scopeLabel(effectiveTargetScope),
            }),
          ),
        )
      : null,
  )
}
