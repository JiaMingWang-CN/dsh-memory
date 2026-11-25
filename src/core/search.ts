/**
 * In-process tokenizer, inverted index and BM25 scorer for memory retrieval.
 *
 * The index lives only in memory and is rebuilt from the domain on startup and
 * after batch maintenance; single-record business changes update it
 * incrementally. Statistics (`matchCount` / `useCount`) never affect scoring or
 * ordering, so search/read bookkeeping cannot boost a memory into view.
 * @module dsh-memory/core/search
 */
import type { MemoryRecord, MemoryScope, MemoryType } from '../shared/types.ts'

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

/** In-memory inverted index over memory records. */
export class SearchIndex {
  private readonly docs = new Map<string, IndexedDoc>()
  private readonly inverted = new Map<string, Map<string, number>>()
  private readonly defaultLimit: number

  constructor(options: SearchIndexOptions = {}) {
    this.defaultLimit = Math.min(
      Math.max(options.defaultLimit ?? DEFAULT_SEARCH_LIMIT, 1),
      MAX_SEARCH_LIMIT,
    )
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.size
  }

  /**
   * Whether a record belongs in the index: only active records are searchable.
   * Expiry is evaluated per query so a single stored flag is sufficient here.
   */
  private isIndexable(record: MemoryRecord): boolean {
    if (record.status !== 'active') return false
    // Global scope is reserved for user preferences; ignore malformed global
    // records so one bad row cannot leak across workspaces.
    return record.scope.kind !== 'global' || record.type === 'preference'
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

  /**
   * Add or replace one record in the index. Non-active records are dropped.
   * @param record - Record to (re)index.
   */
  add(record: MemoryRecord): void {
    this.unlink(record.id)
    if (this.isIndexable(record)) this.link(record)
  }

  /**
   * Remove one record from the index by id.
   * @param id - Memory identity.
   */
  remove(id: string): void {
    this.unlink(id)
  }

  /**
   * Update one record, skipping work when its content revision is unchanged.
   * @param record - Latest record snapshot.
   */
  update(record: MemoryRecord): void {
    const existing = this.docs.get(record.id)
    if (existing !== undefined && existing.revision === record.contentRevision) {
      if (!this.isIndexable(record)) this.unlink(record.id)
      return
    }
    this.add(record)
  }

  /**
   * Rebuild the whole index from a record snapshot. Archived and pending
   * records are intentionally excluded.
   * @param records - All persisted records.
   */
  rebuild(records: Iterable<MemoryRecord>): void {
    this.docs.clear()
    this.inverted.clear()
    for (const record of records) {
      if (this.isIndexable(record)) this.link(record)
    }
  }

  /** Filter indexed active records by scope, expiry, type and tag constraints. */
  private collectVisible(request: BrowseRequest): MemoryRecord[] {
    const nowMs = (request.now ?? new Date()).getTime()
    const scopeMode = request.scope ?? 'auto'
    const visible: MemoryRecord[] = []
    for (const doc of this.docs.values()) {
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
    const docCount = this.docs.size
    let totalLength = 0
    for (const doc of this.docs.values()) totalLength += doc.length
    const averageLength = docCount === 0 ? 0 : totalLength / docCount
    const scored: { record: MemoryRecord; score: number }[] = []
    for (const record of this.collectVisible(request)) {
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
