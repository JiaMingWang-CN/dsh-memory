/**
 * In-process tokenizer, inverted index and BM25 scorer for memory retrieval.
 *
 * The index lives only in memory and is rebuilt from the domain on startup and
 * after batch maintenance; single-record business changes update it
 * incrementally. Statistics (`matchCount` / `useCount`) never affect scoring or
 * ordering, so search/read bookkeeping cannot boost a memory into view.
 * @module memloom/core/search
 */
import type { MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from '../shared/types.ts'

/** Default number of hits returned by one search. */
export const DEFAULT_SEARCH_LIMIT = 20
/** Largest number of hits returned by one search. */
export const MAX_SEARCH_LIMIT = 50

const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 2
const IMPORTANCE_WEIGHT = 0.5
const PINNED_BONUS = 0.25
const SNIPPET_LENGTH = 160

/**
 * Type preference over otherwise equal BM25 relevance. Worklogs are episodic
 * records that should never outrank a durable lesson or wiki entry that matched
 * the same query with the same strength.
 */
const TYPE_WEIGHT: Record<MemoryType, number> = {
  lesson: 1,
  wiki: 1,
  preference: 1.2,
  worklog: 0.6,
}

const LATIN_RUN = /[a-z0-9_]+/g
const CJK_RUN = /[\u4e00-\u9fff]+/g

/**
 * Split text into index terms.
 *
 * Latin runs are lower-cased whole words; CJK runs contribute both single
 * characters (unigrams) and adjacent character pairs (bigrams), so Chinese
 * queries match the same decomposition on both the query and document sides.
 * Whitespace and standalone punctuation never produce a term.
 * @param text - Raw text.
 * @returns The ordered term list, with repeats preserved as frequencies.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const terms: string[] = []
  const latin = lower.match(LATIN_RUN)
  if (latin !== null) terms.push(...latin)
  const cjk = lower.match(CJK_RUN)
  if (cjk !== null) {
    for (const run of cjk) {
      const chars = [...run]
      for (let index = 0; index < chars.length; index += 1) {
        terms.push(chars[index]!)
        if (index + 1 < chars.length) terms.push(`${chars[index]}${chars[index + 1]}`)
      }
    }
  }
  return terms
}

/** One indexed document: its current revision, weighted term frequencies and length. */
interface IndexedDoc {
  revision: number
  record: MemoryRecord
  termFrequency: Map<string, number>
  length: number
}

/** Request accepted by {@link SearchIndex.search}. */
export interface SearchRequest {
  /** Free-text query (already plain text, not necessarily tokenized). */
  query: string
  /** Current workspace key; `null` restricts the query to global memories. */
  workspaceKey: string | null
  /**
   * Scope selection: `auto` (default) is the workspace plus global;
   * `workspace` excludes global records; `global` returns only global records.
   */
  scope?: 'auto' | 'workspace' | 'global'
  /** Optional type filter. */
  types?: MemoryType[]
  /** Optional tag filter; a record must carry every requested tag. */
  tags?: string[]
  /** Page size; clamped to `[1, MAX_SEARCH_LIMIT]`. */
  limit?: number
  /** Clock used to drop expired records; defaults to `new Date()`. */
  now?: Date
}

/** Request accepted by {@link SearchIndex.browse}. */
export type BrowseRequest = Omit<SearchRequest, 'query'>

/** One search hit. */
export interface SearchHit {
  id: string
  type: MemoryType
  title: string
  snippet: string
  scope: MemoryScope
  confidence: number
  updatedAt: string
  score: number
}

/** Result of {@link SearchIndex.search}. */
export interface SearchResult {
  results: SearchHit[]
  total: number
  truncated: boolean
}

/**
 * Whether a memory's scope is visible in one query scope.
 *
 * Global memories are always visible; a workspace memory is visible only when
 * the query carries the exact workspace key.
 */
function scopeMatches(
  scope: MemoryScope,
  workspaceKey: string | null,
  mode: 'auto' | 'workspace' | 'global',
): boolean {
  if (mode === 'global') return scope.kind === 'global'
  if (scope.kind === 'global') return mode === 'auto'
  if (workspaceKey === null) return false
  return scope.key === workspaceKey
}

/** Build a snippet window of the body that covers the most distinct query terms. */
function makeSnippet(body: string, queryTerms: readonly string[]): string {
  if (body.length <= SNIPPET_LENGTH) return body
  const terms = [...new Set(queryTerms)]
  const lastStart = body.length - SNIPPET_LENGTH
  let bestStart = 0
  let bestCount = 0
  const consider = (start: number): void => {
    const segment = body.slice(start, start + SNIPPET_LENGTH).toLowerCase()
    let count = 0
    for (const term of terms) if (segment.includes(term)) count += 1
    if (count > bestCount) {
      bestCount = count
      bestStart = start
    }
  }
  for (let start = 0; start <= lastStart; start += 20) consider(start)
  // The last legal window is not a multiple of the step; skipping it would
  // truncate a query term that sits at the very end of the body.
  if (lastStart > 0) consider(lastStart)
  if (bestCount === 0) return body.slice(0, SNIPPET_LENGTH)
  return body.slice(bestStart, bestStart + SNIPPET_LENGTH)
}

/** Options for {@link SearchIndex}. */
export interface SearchIndexOptions {
  /** Default page size when a request omits `limit`. */
  defaultLimit?: number
}

/** Shared inverted-index storage and BM25 scorer used by both search indexes. */
class InvertedBm25Core {
  private readonly docs = new Map<string, IndexedDoc>()
  private readonly inverted = new Map<string, Map<string, number>>()

  get size(): number {
    return this.docs.size
  }

  values(): IterableIterator<IndexedDoc> {
    return this.docs.values()
  }

  private computeTerms(record: MemoryRecord): {
    termFrequency: Map<string, number>
    length: number
  } {
    const titleTerms = tokenize(record.title)
    const bodyTerms = tokenize(record.body)
    const termFrequency = new Map<string, number>()
    for (const term of bodyTerms) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1)
    for (const term of titleTerms) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + TITLE_WEIGHT)
    }
    return { termFrequency, length: bodyTerms.length + titleTerms.length }
  }

  private link(record: MemoryRecord): void {
    const { termFrequency, length } = this.computeTerms(record)
    const doc: IndexedDoc = {
      revision: record.contentRevision,
      record,
      termFrequency,
      length,
    }
    this.docs.set(record.id, doc)
    for (const term of termFrequency.keys()) {
      let postings = this.inverted.get(term)
      if (postings === undefined) {
        postings = new Map<string, number>()
        this.inverted.set(term, postings)
      }
      postings.set(record.id, termFrequency.get(term)!)
    }
  }

  private unlink(id: string): void {
    const doc = this.docs.get(id)
    if (doc === undefined) return
    for (const term of doc.termFrequency.keys()) {
      const postings = this.inverted.get(term)
      if (postings === undefined) continue
      postings.delete(id)
      if (postings.size === 0) this.inverted.delete(term)
    }
    this.docs.delete(id)
  }

  add(record: MemoryRecord, isIndexable: (candidate: MemoryRecord) => boolean): void {
    this.unlink(record.id)
    if (isIndexable(record)) this.link(record)
  }

  remove(id: string): void {
    this.unlink(id)
  }

  update(record: MemoryRecord, isIndexable: (candidate: MemoryRecord) => boolean): void {
    const existing = this.docs.get(record.id)
    if (existing !== undefined && existing.revision === record.contentRevision) {
      if (!isIndexable(record)) this.unlink(record.id)
      return
    }
    this.add(record, isIndexable)
  }

  rebuild(
    records: Iterable<MemoryRecord>,
    isIndexable: (candidate: MemoryRecord) => boolean,
  ): void {
    this.docs.clear()
    this.inverted.clear()
    for (const record of records) {
      if (isIndexable(record)) this.link(record)
    }
  }

  scoreRecords(
    records: readonly MemoryRecord[],
    queryTerms: readonly string[],
  ): { record: MemoryRecord; score: number }[] {
    const docCount = this.docs.size
    let totalLength = 0
    for (const doc of this.docs.values()) totalLength += doc.length
    const averageLength = docCount === 0 ? 0 : totalLength / docCount
    const scored: { record: MemoryRecord; score: number }[] = []
    for (const record of records) {
      const doc = this.docs.get(record.id)
      if (doc === undefined) continue
      let score = 0
      for (const term of queryTerms) {
        const postings = this.inverted.get(term)
        if (postings === undefined) continue
        const termFrequency = postings.get(record.id)
        if (termFrequency === undefined || termFrequency === 0) continue
        const documentFrequency = postings.size
        const idf = Math.log(1 + (docCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
        const normalization =
          K1 * (1 - B + (B * doc.length) / (averageLength === 0 ? 1 : averageLength))
        score += (idf * termFrequency * (K1 + 1)) / (termFrequency + normalization)
      }
      if (score <= 0) continue
      score *= TYPE_WEIGHT[record.type]
      score += record.importance * IMPORTANCE_WEIGHT + (record.pinned ? PINNED_BONUS : 0)
      scored.push({ record, score })
    }
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        right.record.updatedAt.localeCompare(left.record.updatedAt) ||
        left.record.id.localeCompare(right.record.id),
    )
    return scored
  }
}

/** In-memory inverted index over active memory records. */
export class SearchIndex {
  private readonly core = new InvertedBm25Core()
  private readonly defaultLimit: number

  constructor(options: SearchIndexOptions = {}) {
    this.defaultLimit = Math.min(
      Math.max(options.defaultLimit ?? DEFAULT_SEARCH_LIMIT, 1),
      MAX_SEARCH_LIMIT,
    )
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.core.size
  }

  /**
   * Whether a record belongs in the index: only active records are searchable.
   * Expiry is evaluated per query so a single stored flag is sufficient here.
   */
  private readonly isIndexable = (record: MemoryRecord): boolean => {
    if (record.status !== 'active') return false
    // Global scope is reserved for user preferences; ignore malformed global
    // records so one bad row cannot leak across workspaces.
    return record.scope.kind !== 'global' || record.type === 'preference'
  }

  /**
   * Add or replace one record in the index. Non-active records are dropped.
   * @param record - Record to (re)index.
   */
  add(record: MemoryRecord): void {
    this.core.add(record, this.isIndexable)
  }

  /**
   * Remove one record from the index by id.
   * @param id - Memory identity.
   */
  remove(id: string): void {
    this.core.remove(id)
  }

  /**
   * Update one record, skipping work when its content revision is unchanged.
   * @param record - Latest record snapshot.
   */
  update(record: MemoryRecord): void {
    this.core.update(record, this.isIndexable)
  }

  /**
   * Rebuild the whole index from a record snapshot. Archived and pending
   * records are intentionally excluded.
   * @param records - All persisted records.
   */
  rebuild(records: Iterable<MemoryRecord>): void {
    this.core.rebuild(records, this.isIndexable)
  }

  /** Filter indexed active records by scope, expiry, type and tag constraints. */
  private collectVisible(request: BrowseRequest): MemoryRecord[] {
    const nowMs = (request.now ?? new Date()).getTime()
    const scopeMode = request.scope ?? 'auto'
    const visible: MemoryRecord[] = []
    for (const doc of this.core.values()) {
      const record = doc.record
      if (!scopeMatches(record.scope, request.workspaceKey, scopeMode)) continue
      if (record.status !== 'active') continue
      if (record.scope.kind === 'global' && record.type !== 'preference') continue
      if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) continue
      if (request.types !== undefined && request.types.length > 0) {
        if (!request.types.includes(record.type)) continue
      }
      if (request.tags !== undefined && !request.tags.every((tag) => record.tags.includes(tag))) {
        continue
      }
      visible.push(record)
    }
    return visible
  }

  /**
   * List visible active memories without a keyword query, ordered by `pinned`
   * first, `importance` descending, then `updatedAt` descending.
   * @param request - Scope, type/tag filters, page size and clock.
   * @returns Ranked summaries plus total/truncation metadata.
   */
  browse(request: BrowseRequest): SearchResult {
    const limit = Math.min(Math.max(request.limit ?? this.defaultLimit, 1), MAX_SEARCH_LIMIT)
    const records = this.collectVisible(request)
    records.sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.importance - left.importance ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    const total = records.length
    const page = records.slice(0, limit)
    const results: SearchHit[] = page.map((record) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      snippet: makeSnippet(record.body, []),
      scope: record.scope,
      confidence: record.confidence,
      updatedAt: record.updatedAt,
      score: 0,
    }))
    return { results, total, truncated: total > limit }
  }

  /**
   * Score and filter the indexed records for one request.
   * @param request - Query, scope, type/tag filters, page size and clock.
   * @returns The ranked page plus total/truncation metadata.
   */
  search(request: SearchRequest): SearchResult {
    const queryTerms = [...new Set(tokenize(request.query))]
    const limit = Math.min(Math.max(request.limit ?? this.defaultLimit, 1), MAX_SEARCH_LIMIT)
    if (queryTerms.length === 0) return { results: [], total: 0, truncated: false }
    const scored = this.core.scoreRecords(this.collectVisible(request), queryTerms)
    const total = scored.length
    const page = scored.slice(0, limit)
    const results: SearchHit[] = page.map(({ record, score }) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      snippet: makeSnippet(record.body, queryTerms),
      scope: record.scope,
      confidence: record.confidence,
      updatedAt: record.updatedAt,
      score,
    }))
    return { results, total, truncated: total > limit }
  }
}

/** Request accepted by {@link ManagementSearchIndex.search}. */
export interface ManagementSearchRequest {
  query?: string
  workspaceKey?: string | 'all' | null
  types?: readonly MemoryType[]
  statuses?: readonly MemoryStatus[]
  limit?: number
  offset?: number
  includeExpired?: boolean
  now?: Date
}

/** One management search hit with normalized BM25 score and full record. */
export interface ManagementSearchHit {
  record: MemoryRecord
  score: number
  normalizedScore: number
  snippet: string
}

/** Paginated result returned by {@link ManagementSearchIndex.search}. */
export interface ManagementSearchResult {
  items: ManagementSearchHit[]
  total: number
  limit: number
  offset: number
  truncated: boolean
}

/**
 * In-memory inverted index for the management UI covering active, pending and
 * archived records across all workspaces with offset pagination.
 */
export class ManagementSearchIndex {
  private readonly core = new InvertedBm25Core()
  private readonly defaultLimit: number

  constructor(options: SearchIndexOptions = {}) {
    this.defaultLimit = Math.max(options.defaultLimit ?? DEFAULT_SEARCH_LIMIT, 1)
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.core.size
  }

  private readonly isIndexable = (record: MemoryRecord): boolean => {
    if (record.status !== 'active' && record.status !== 'pending' && record.status !== 'archived') {
      return false
    }
    if (
      typeof record.id !== 'string' ||
      typeof record.title !== 'string' ||
      typeof record.body !== 'string' ||
      record.scope === undefined
    ) {
      return false
    }
    return record.scope.kind !== 'global' || record.type === 'preference'
  }

  /** Add or replace one record in the management index. */
  add(record: MemoryRecord): void {
    this.core.add(record, this.isIndexable)
  }

  /** Remove one record from the management index by id. */
  remove(id: string): void {
    this.core.remove(id)
  }

  /** Update one record in the management index when its revision changed. */
  update(record: MemoryRecord): void {
    this.core.update(record, this.isIndexable)
  }

  /** Rebuild the management index from all non-malformed records. */
  rebuild(records: Iterable<MemoryRecord>): void {
    this.core.rebuild(records, this.isIndexable)
  }

  private collectVisible(request: ManagementSearchRequest): MemoryRecord[] {
    const nowMs = (request.now ?? new Date()).getTime()
    const target = request.workspaceKey === undefined ? 'all' : request.workspaceKey
    const visible: MemoryRecord[] = []
    for (const doc of this.core.values()) {
      const record = doc.record
      if (target !== 'all' && record.scope.kind !== 'global') {
        if (target === null || record.scope.key !== target) continue
      }
      if (request.statuses !== undefined && request.statuses.length > 0) {
        if (!request.statuses.includes(record.status)) continue
      }
      if (request.types !== undefined && request.types.length > 0) {
        if (!request.types.includes(record.type)) continue
      }
      if (
        request.includeExpired !== true &&
        record.status === 'active' &&
        record.expiresAt !== undefined
      ) {
        const expiresMs = Date.parse(record.expiresAt)
        if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) continue
      }
      visible.push(record)
    }
    return visible
  }

  /**
   * Search or browse management records across statuses and workspaces.
   * Without a keyword query, returns visible records sorted by `updatedAt`
   * descending with `score: 0` and `normalizedScore: 0`.
   */
  search(request: ManagementSearchRequest = {}): ManagementSearchResult {
    const limit = Math.max(1, Math.floor(request.limit ?? this.defaultLimit))
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const rawQuery = request.query?.trim() ?? ''
    if (rawQuery === '') {
      const records = this.collectVisible(request)
      records.sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      )
      const total = records.length
      const page = records.slice(offset, offset + limit)
      const items: ManagementSearchHit[] = page.map((record) => ({
        record: structuredClone(record),
        score: 0,
        normalizedScore: 0,
        snippet: makeSnippet(record.body, []),
      }))
      return { items, total, limit, offset, truncated: offset + limit < total }
    }
    const queryTerms = [...new Set(tokenize(rawQuery))]
    if (queryTerms.length === 0) {
      return { items: [], total: 0, limit, offset, truncated: false }
    }
    const scored = this.core.scoreRecords(this.collectVisible(request), queryTerms)
    const total = scored.length
    const maxScore = scored[0]?.score ?? 0
    const page = scored.slice(offset, offset + limit)
    const items: ManagementSearchHit[] = page.map(({ record, score }) => ({
      record: structuredClone(record),
      score,
      normalizedScore: maxScore > 0 ? score / maxScore : 0,
      snippet: makeSnippet(record.body, queryTerms),
    }))
    return { items, total, limit, offset, truncated: offset + limit < total }
  }
}
