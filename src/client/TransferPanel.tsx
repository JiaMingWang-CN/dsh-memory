/**
 * Import/export panel for one workspace scope.
 *
 * Split into two clear cards — Export and Import — so the import mode never
 * looks like it affects export. Import supports click or drag-and-drop file
 * selection, previews the parsed document summary, and enforces workspace
 * mapping before any destructive `replace`.
 * @module dsh-memory/client/TransferPanel
 */
import * as React from 'react'
import type { ImportReport, MemoryExport, WorkspaceInfo } from './context.ts'
import { errorText } from './errors.ts'
import { formatMessage, t } from './locales.ts'
import { Button, Select, Tag } from './ui.tsx'
import { workspaceKeyOf } from './WorkspaceFilter.tsx'

const h = React.createElement

/** Scope selector shared with the export/import Remote calls. */
export type TransferScope = 'all' | 'global' | { workspaceKey: string }

/** One resolved workspace mapping entry. */
export type TransferMapping = Record<string, { key: string; root: string }>

/** Props accepted by {@link TransferPanel}. */
export interface TransferPanelProps {
  scope?: TransferScope
  /** Local workspaces a file key may be mapped onto. */
  workspaces?: readonly WorkspaceInfo[]
  onExport?: (scope: TransferScope) => Promise<void> | void
  onImport?: (
    mode: 'merge' | 'replace',
    payload: unknown,
    targetScope: TransferScope,
    mapping: TransferMapping,
  ) => Promise<ImportReport | void>
}

const FILE_INPUT_ID = 'dsh-mem-import-file'

/** Workspace keys an export document refers to. */
function workspaceKeysOf(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return []
  const document = payload as Partial<MemoryExport>
  if (!Array.isArray(document.memories) || !Array.isArray(document.episodes)) return []
  const keys = new Set<string>()
  for (const memory of document.memories) {
    if (memory.scope.kind === 'workspace') keys.add(memory.scope.key)
  }
  for (const episode of document.episodes) {
    if (typeof episode.workspaceKey === 'string') keys.add(episode.workspaceKey)
  }
  return [...keys]
}

/** Whether a parsed value looks like a dsh-memory export document. */
function isExportDocument(payload: unknown): payload is MemoryExport {
  if (payload === null || typeof payload !== 'object') return false
  const document = payload as Partial<MemoryExport>
  return (
    document.format === 'dsh-memory' &&
    document.version === 1 &&
    Array.isArray(document.memories) &&
    Array.isArray(document.episodes)
  )
}

/** Read one selected file as text, falling back to FileReader where needed. */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('file could not be read'))
    reader.readAsText(file)
  })
}

/** Format an ISO export timestamp for summary display. */
function formatExportedAt(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Render the export and import cards.
 * @param props - Scope, local workspaces and export/import callbacks.
 * @returns The transfer panel element.
 */
export function TransferPanel(props: TransferPanelProps): React.ReactElement {
  const [mode, setMode] = React.useState<'merge' | 'replace'>('merge')
  const [confirming, setConfirming] = React.useState(false)
  const [confirmScope, setConfirmScope] = React.useState<TransferScope | undefined>(undefined)
  const [payload, setPayload] = React.useState<MemoryExport | undefined>(undefined)
  const [fileName, setFileName] = React.useState('')
  const [parseError, setParseError] = React.useState('')
  const [mapping, setMapping] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState<'export' | 'import' | undefined>(undefined)
  const [report, setReport] = React.useState<ImportReport | undefined>(undefined)
  const [actionError, setActionError] = React.useState('')
  const [dragging, setDragging] = React.useState(false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const fileSeq = React.useRef(0)

  const workspaces = props.workspaces ?? []
  const available = workspaces.map((workspace) => ({
    ...workspace,
    key: workspace.key ?? workspaceKeyOf(workspace.path),
  }))
  const scopeKey =
    props.scope === undefined
      ? ''
      : typeof props.scope === 'string'
        ? props.scope
        : props.scope.workspaceKey
  React.useEffect(() => {
    setConfirming(false)
    setConfirmScope(undefined)
  }, [scopeKey])

  const targetScope = confirmScope ?? props.scope ?? 'all'
  const sourceKeys = React.useMemo(() => workspaceKeysOf(payload), [payload])
  const missingMapping = sourceKeys.filter((key) => (mapping[key] ?? '') === '')

  const clearFile = (): void => {
    fileSeq.current += 1
    setPayload(undefined)
    setFileName('')
    setParseError('')
    setMapping({})
    setConfirming(false)
    setConfirmScope(undefined)
    setReport(undefined)
    setActionError('')
  }

  const pickFile = (file: File | undefined): void => {
    const seq = ++fileSeq.current
    setConfirming(false)
    setConfirmScope(undefined)
    setReport(undefined)
    setActionError('')
    setParseError('')
    if (file === undefined) return
    setFileName(file.name)
    void readFileText(file)
      .then((text) => {
        if (seq !== fileSeq.current) return
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          setPayload(undefined)
          setMapping({})
          setParseError(t('transfer.parseError'))
          return
        }
        if (!isExportDocument(parsed)) {
          setPayload(undefined)
          setMapping({})
          setParseError(t('transfer.parseError'))
          return
        }
        setPayload(parsed)
        const local = new Set(available.map((workspace) => workspace.key))
        const defaults: Record<string, string> = {}
        for (const key of workspaceKeysOf(parsed)) defaults[key] = local.has(key) ? key : ''
        setMapping(defaults)
      })
      .catch(() => {
        if (seq !== fileSeq.current) return
        setPayload(undefined)
        setMapping({})
        setParseError(t('transfer.parseError'))
      })
  }

  const resolveMapping = (): TransferMapping => {
    const resolved: TransferMapping = {}
    for (const key of sourceKeys) {
      const target = mapping[key] ?? ''
      if (target === '') continue
      const workspace = available.find((candidate) => candidate.key === target)
      if (workspace === undefined) continue
      resolved[key] = { key: workspace.key, root: workspace.path }
    }
    return resolved
  }

  const scopeLabel = (scope: TransferScope): string => {
    if (scope === 'all') return t('scope.all')
    if (scope === 'global') return t('scope.global')
    const matched = available.find((workspace) => workspace.key === scope.workspaceKey)
    return matched?.title !== undefined && matched.title !== ''
      ? `${matched.title} (${scope.workspaceKey})`
      : scope.workspaceKey
  }

  const exportNow = async (): Promise<void> => {
    if (busy !== undefined) return
    setBusy('export')
    setActionError('')
    try {
      await props.onExport?.(props.scope ?? 'all')
    } catch (reason) {
      setActionError(errorText(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const startImport = (): void => {
    if (busy !== undefined) return
    if (payload === undefined) {
      setActionError(t('transfer.needFile'))
      return
    }
    if (mode === 'replace' && missingMapping.length > 0) {
      setActionError(t('transfer.needMapping'))
      return
    }
    if (mode === 'replace' && !confirming) {
      setConfirmScope(props.scope ?? 'all')
      setConfirming(true)
      return
    }
    const resolved = resolveMapping()
    setConfirming(false)
    setConfirmScope(undefined)
    void runImport(resolved)
  }

  const runImport = async (resolved: TransferMapping): Promise<void> => {
    setBusy('import')
    setActionError('')
    setReport(undefined)
    try {
      const result = await props.onImport?.(mode, payload, targetScope, resolved)
      if (result !== undefined) setReport(result)
    } catch (reason) {
      setActionError(errorText(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const submitLabel = busy === 'import' ? t('transfer.importing') : t('transfer.import')
  const currentScope = props.scope ?? 'all'

  return h(
    'div',
    { className: 'dsh-mem-stack' },
    // Export card
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h(
        'div',
        { className: 'dsh-mem-section-head' },
        h(
          'div',
          null,
          h('h3', { className: 'dsh-mem-section-title' }, t('transfer.exportTitle')),
          h('p', { className: 'dsh-mem-section-sub' }, t('transfer.exportDesc')),
        ),
        h(Tag, null, `${t('transfer.target')}: ${scopeLabel(currentScope)}`),
      ),
      h('p', { className: 'dsh-mem-hint' }, t('transfer.privacy')),
      h(
        'div',
        { className: 'dsh-mem-actions' },
        h(
          Button,
          {
            variant: 'primary',
            ...(busy === 'export' ? { disabled: true } : {}),
            onClick: () => {
              void exportNow()
            },
          },
          busy === 'export' ? t('transfer.exporting') : t('transfer.export'),
        ),
      ),
    ),
    // Import card
    h(
      'section',
      { className: 'dsh-mem-section-card' },
      h('h3', { className: 'dsh-mem-section-title' }, t('transfer.importTitle')),
      h('p', { className: 'dsh-mem-section-sub' }, t('transfer.importDesc')),
      h(
        'div',
        {
          className: 'dsh-mem-dropzone',
          'data-dragging': dragging ? 'true' : 'false',
          onDragOver: (event: React.DragEvent) => {
            event.preventDefault()
            if (busy === undefined) setDragging(true)
          },
          onDragLeave: () => setDragging(false),
          onDrop: (event: React.DragEvent) => {
            event.preventDefault()
            setDragging(false)
            if (busy !== undefined) return
            pickFile(event.dataTransfer.files?.[0])
          },
        },
        h('p', { className: 'dsh-mem-hint' }, fileName === '' ? t('transfer.dropHint') : fileName),
        h(
          'div',
          { className: 'dsh-mem-actions' },
          h(
            Button,
            {
              ...(busy !== undefined ? { disabled: true } : {}),
              onClick: () => fileInput.current?.click(),
            },
            t('transfer.chooseFile'),
          ),
          fileName === ''
            ? null
            : h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  ...(busy !== undefined ? { disabled: true } : {}),
                  onClick: clearFile,
                },
                t('transfer.clearFile'),
              ),
        ),
        h('input', {
          ref: fileInput,
          id: FILE_INPUT_ID,
          type: 'file',
          accept: 'application/json,.json',
          'aria-label': t('transfer.import'),
          style: { display: 'none' },
          disabled: busy !== undefined,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
            pickFile(event.target.files?.[0])
            event.target.value = ''
          },
        }),
      ),
      parseError === ''
        ? null
        : h('p', { className: 'dsh-mem-confirm', role: 'alert' }, parseError),
      payload === undefined
        ? null
        : h(
            'dl',
            { className: 'dsh-mem-facts' },
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('transfer.summaryMemories')),
              h('dd', null, String(payload.memories.length)),
            ),
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('transfer.summaryEpisodes')),
              h('dd', null, String(payload.episodes.length)),
            ),
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('transfer.summaryWorkspaces')),
              h('dd', null, String(sourceKeys.length)),
            ),
            h(
              'div',
              { className: 'dsh-mem-fact' },
              h('dt', null, t('transfer.summaryExportedAt')),
              h('dd', null, formatExportedAt(payload.exportedAt)),
            ),
          ),
      h(
        'div',
        { className: 'dsh-mem-setting-row' },
        h(
          'span',
          { className: 'dsh-mem-switchtext' },
          h('span', { className: 'dsh-mem-switchlabel' }, t('transfer.mode')),
          h(
            'span',
            { className: 'dsh-mem-switchhint' },
            `${t('transfer.target')}: ${scopeLabel(currentScope)}`,
          ),
        ),
        h(
          'div',
          { className: 'dsh-mem-setting-control' },
          h(Select, {
            label: t('transfer.mode'),
            value: mode,
            options: [
              { value: 'merge', label: t('transfer.merge') },
              { value: 'replace', label: t('transfer.replace') },
            ],
            disabled: busy !== undefined,
            onChange: (value) => {
              setMode(value === 'replace' ? 'replace' : 'merge')
              setConfirming(false)
              setConfirmScope(undefined)
            },
          }),
        ),
      ),
      sourceKeys.length === 0
        ? null
        : h(
            'div',
            { className: 'dsh-mem-mapping' },
            h('p', { className: 'dsh-mem-label', style: { margin: 0 } }, t('transfer.mapping')),
            h('p', { className: 'dsh-mem-hint' }, t('transfer.mappingHint')),
            ...sourceKeys.map((key) =>
              h(Select, {
                key,
                label: `${key}: ${t('transfer.mapping')}`,
                value: mapping[key] ?? '',
                disabled: busy !== undefined,
                options: [
                  { value: '', label: `${key} → ${t('transfer.mappingSkip')}` },
                  ...available.map((workspace) => ({
                    value: workspace.key,
                    label:
                      workspace.title !== undefined && workspace.title !== ''
                        ? `${key} → ${workspace.title} (${workspace.key})`
                        : `${key} → ${workspace.key}`,
                  })),
                ],
                onChange: (value) => {
                  setMapping((current) => ({ ...current, [key]: value }))
                  setConfirming(false)
                  setConfirmScope(undefined)
                },
              }),
            ),
          ),
      actionError === ''
        ? null
        : h('p', { className: 'dsh-mem-confirm', role: 'alert' }, actionError),
      confirming
        ? h(
            'div',
            { className: 'dsh-mem-confirm', role: 'alert' },
            h('span', null, t('transfer.confirmReplace')),
            h(
              'span',
              { className: 'dsh-mem-count' },
              `${t('transfer.target')}: ${scopeLabel(targetScope)}`,
            ),
            h(
              Button,
              { variant: 'danger', size: 'sm', disabled: busy !== undefined, onClick: startImport },
              t('common.confirm'),
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                onClick: () => {
                  setConfirming(false)
                  setConfirmScope(undefined)
                },
              },
              t('common.cancel'),
            ),
          )
        : h(
            'div',
            { className: 'dsh-mem-actions' },
            h(
              Button,
              {
                variant: 'primary',
                ...(payload === undefined || busy !== undefined ? { disabled: true } : {}),
                onClick: startImport,
              },
              submitLabel,
            ),
          ),
      report === undefined
        ? null
        : h(
            'div',
            { className: 'dsh-mem-report', role: 'status' },
            h(
              'p',
              null,
              `${t('transfer.reportTitle')}: ${formatMessage('transfer.report', {
                created: report.created,
                skipped: report.skipped,
                replaced: report.replaced,
              })}`,
            ),
            report.unmapped.length === 0
              ? null
              : h('p', null, `${t('transfer.unmapped')} ${report.unmapped.join(', ')}`),
            report.errors.length === 0
              ? null
              : h(
                  'div',
                  null,
                  h('p', null, t('transfer.errors')),
                  ...report.errors.map((item, index) =>
                    h(
                      'p',
                      { key: `${item.id ?? 'item'}-${index}` },
                      `${item.id ?? ''} ${item.message}`,
                    ),
                  ),
                ),
          ),
    ),
  )
}
