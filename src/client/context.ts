/**
 * Minimal Client contract for the Memloom Settings surface.
 *
 * The Client bundle must not import any Harness Client package as a module, so
 * this file declares only the service shapes the plugin actually uses. They are
 * structural descriptions of the live `ctx.slots`, `ctx.locale` and `ctx.remote`
 * services, not a re-export of their packages.
 * @module memloom/client/context
 */
import type { MemoryConfig } from '../host/config.ts'
import type {
  DreamRun,
  MemoryRecord,
  MemoryScope,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
} from '../shared/types.ts'
import type {
  ExportScope,
  ImportOptions,
  ImportReport,
  MemoryExport,
  PurgeReport,
  PurgeRequest,
  RebuildReport,
  RebuildRequest,
} from '../host/exchange.ts'
import type { DreamUndoReport } from '../host/operations.ts'

/** Translation dictionary for one locale. */
export type LocaleDict = Record<string, string>

/** One slot registration accepted by the Client slot service. */
export interface SlotRegistration {
  name: string
  /** Stable cell key for list/single slots. */
  id?: string
  /** Dispatch key for keyed slots such as `tool.call.toolview`. */
  key?: string
  order?: number
  label?: string | (() => string)
}

/** `ctx.slots` face used by the plugin. */
export interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void
  register(registration: SlotRegistration, component: unknown): () => void
}

/** `ctx.locale` face used by the plugin. */
export interface ClientLocale {
  register(namespace: string, dicts: { zh: LocaleDict; en: LocaleDict }): () => void
  bind(namespace: string): (key: string) => string
  subscribe?(listener: () => void): () => void
  getLocale?(): { id?: string }
}

/** Management overview returned by the Host. */
export interface MemoryOverview {
  workspaceKey: string | 'all' | null
  counts: { active: number; pending: number; archived: number; stored: number }
  pendingReview: number
  recentDream: DreamRun | null
  index: { entries: number; bytes: number }
}

/** Paged management list response. */
export interface MemoryListResult {
  items: MemoryRecord[]
  total: number
  limit: number
  offset: number
  truncated: boolean
}

/** Management list filters. */
export interface MemoryListRequest {
  workspaceKey?: string | 'all' | null
  type?: MemoryType
  status?: MemoryStatus
  query?: string
  limit?: number
  offset?: number
  includeExpired?: boolean
}

/** Fields accepted by the Remote create endpoint. */
export interface MemoryCreateInput {
  type: MemoryType
  title: string
  body: string
  scope?: 'workspace' | 'global'
  workspaceKey?: string
  workspaceRoot?: string
  tags?: string[]
  importance?: number
  confidence?: number
  pinned?: boolean
  status?: 'active' | 'pending'
}

/** Fields accepted by the Remote update endpoint. */
export interface MemoryUpdateInput {
  id: string
  expectedContentRevision: number
  type?: MemoryType
  title?: string
  body?: string
  tags?: string[]
  importance?: number
  confidence?: number
  pinned?: boolean
  status?: 'active' | 'archived'
  scope?: 'workspace' | 'global'
  workspaceKey?: string
  workspaceRoot?: string
}

/** One selectable provider or model. */
export interface ModelCatalogEntry {
  id: string
  name: string
}

/** Provider/model catalog for the dream-model picker. */
export interface MemoryModelCatalog {
  providers: ModelCatalogEntry[]
  models: Record<string, ModelCatalogEntry[]>
  /** Model a follow-session dream inherits when the session names none. */
  defaultSelection?: { provider: string; model: string; reasoningEffort?: string }
}

/** Reasoning efforts one exact model advertises. */
export interface MemoryModelEfforts {
  efforts: ModelCatalogEntry[]
  defaultEffort?: string
}

/** `ctx.remote.memory` management namespace. */
export interface MemoryRemote {
  overview(request: { workspaceKey: string | 'all' | null }): Promise<MemoryOverview>
  /** Workspace key of the most recent session event, or null before one exists. */
  activeWorkspace(): Promise<string | null>
  list(request: MemoryListRequest): Promise<MemoryListResult>
  view(request: { id: string }): Promise<{ record: MemoryRecord; sources: MemorySourceRef[] }>
  create(input: MemoryCreateInput): Promise<MemoryRecord>
  update(input: MemoryUpdateInput): Promise<MemoryRecord>
  delete(request: {
    id: string
    permanent?: boolean
    confirm?: boolean
    actor?: 'user' | 'model'
  }): Promise<{ deleted: boolean; record: MemoryRecord | null }>
  restore(request: { id: string }): Promise<MemoryRecord>
  review(request: { id: string; action: 'accept' | 'reject' }): Promise<MemoryRecord>
  dream(request: {
    scope: 'workspace' | 'global'
    workspaceKey?: string
    workspaceRoot?: string
    maxEpisodes?: number
    since?: string
  }): Promise<DreamRun>
  dreamStatus(): Promise<DreamRun | null>
  undoDream(request: { id: string }): Promise<DreamUndoReport>
  cancelDream(request: { id: string }): Promise<boolean>
  export(request: { scope: ExportScope; includeArchived?: boolean }): Promise<MemoryExport>
  import(request: { payload: MemoryExport; options?: ImportOptions }): Promise<ImportReport>
  rebuild(request: RebuildRequest): Promise<RebuildReport>
  purgeAll(request: PurgeRequest): Promise<PurgeReport>
  getConfig(): Promise<MemoryConfig>
  updateConfig(
    patch: Partial<MemoryConfig>,
  ): Promise<{ restartRequired: boolean; config: MemoryConfig }>
  modelCatalog(): Promise<MemoryModelCatalog>
  modelEfforts(request: { provider: string; model: string }): Promise<MemoryModelEfforts>
}

/** `ctx.remote` face: the memory namespace plus forwarded host events. */
export interface ClientRemote {
  memory: MemoryRemote
  /** Mount one generated/descriptor contribution in the calling fiber. */
  $mount?(contribution: unknown): (() => void) | Promise<(() => void) | void> | void
  $on(event: string, listener: (...args: unknown[]) => void): () => void
}

/** One workspace row the selector can show. */
export interface WorkspaceInfo {
  id: string
  title?: string
  path: string
  updatedAt?: string
  /** Normalized path the Host stores as a memory workspace key. */
  key?: string
}

/** A workspace-listing face, matching the Settings slot's `useWorkspaces` view. */
export interface WorkspacesFace {
  list(): WorkspaceInfo[]
}

/** The reduced Client context passed to `apply`. */
export interface ClientContext {
  slots: ClientSlots
  locale: ClientLocale
  remote: ClientRemote
  workspaces?: WorkspacesFace
  /** Read a provided service without the inject requirement (Cordis `ctx.get`). */
  get?(name: string): unknown
  effect?(callback: () => void | (() => void)): () => void
}

export type {
  DreamRun,
  ImportReport,
  MemoryConfig,
  MemoryExport,
  MemoryRecord,
  MemoryScope,
  MemorySourceRef,
  MemoryStatus,
  MemoryType,
}
