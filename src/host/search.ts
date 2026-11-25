/**
 * Re-export in-process BM25 search helpers from the shared core.
 * @module dsh-memory/host/search
 */
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SearchIndex,
  tokenize,
  type BrowseRequest,
  type SearchHit,
  type SearchIndexOptions,
  type SearchRequest,
  type SearchResult,
} from '../core/search.ts'
