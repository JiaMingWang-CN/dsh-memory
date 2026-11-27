/**
 * Shared capture noise filter for host and AGY episode pipelines.
 *
 * Filters out transient tool failures and aborted/cancelled turn noise before
 * they enter the episode queue and trigger low-value Dream proposals.
 * @module memloom/core/capture-filter
 */

const TRANSIENT_FAILURE_CODES = new Set([
  'UNKNOWN',
  'UNKNOWN_TOOL',
  'FS_NOT_FOUND',
  'FS_EDIT_NOT_FOUND',
  'ENOENT',
  'SEARCH_FAILED',
  'WEB_PROVIDER_ERROR',
  'ABORTED',
  'CANCELLED',
  'CANCELED',
  'USER_CANCELED',
  'TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'RATE_LIMIT',
  '429',
])

const TRANSIENT_ERROR_PATTERN =
  /\b(?:UNKNOWN_TOOL|FS_NOT_FOUND|FS_EDIT_NOT_FOUND|SEARCH_FAILED|WEB_PROVIDER_ERROR|ETIMEDOUT|ECONNRESET|RATE_LIMIT)\b|sandbox escalation/i

/**
 * Return `true` when a tool failure represents transient or generic lookup/retry
 * noise that should not be captured as a standalone `tool-failure` episode.
 */
export function isTransientToolFailure(code: string, errorText?: string): boolean {
  const normalized = code.trim().toUpperCase()
  if (TRANSIENT_FAILURE_CODES.has(normalized)) {
    return true
  }
  if (errorText !== undefined && TRANSIENT_ERROR_PATTERN.test(errorText)) {
    return true
  }
  return false
}
