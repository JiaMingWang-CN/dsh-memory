/**
 * Secret detection and redaction applied before text is persisted.
 * @module dsh-memory/host/redact
 */
const REDACTED = '[REDACTED]'

const CREDENTIAL_KEY = String.raw`[A-Za-z0-9_]*(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*`

/**
 * Shared `sk-` key rule used by both redaction and explicit-write refusal.
 * It covers prefixed provider keys (`sk-proj-...`, `sk-ant-...`), plain long
 * tokens without hyphens, underscore/hyphen separated key shapes, and
 * multi-hyphen keys that contain at least one digit or uppercase letter, while
 * leaving lowercase tutorial phrases such as `sk-learn-more-and-more-advanced`
 * alone.
 */
const SK_KEY_SOURCE = String.raw`\bsk-(?:(?:proj|ant|live|test|test_|live_)-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_]{20,}|[A-Za-z0-9_]+-[A-Za-z0-9]{20,}|(?=[A-Za-z0-9_-]*[0-9A-Z])(?:[A-Za-z0-9_]+-){2,}[A-Za-z0-9_]{8,})\b`

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  new RegExp(SK_KEY_SOURCE, 'g'),
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Credential assignments: `password=hunter2`, `DATABASE_PASSWORD=hunter2`,
  // `OPENAI_API_KEY=...`, `api_key: value`, and JSON/JS forms such as
  // `"password":"hunter2"`. The key may carry a prefix (underscore or letters),
  // quotes are allowed around the value, and a quoted value may contain spaces.
  new RegExp(
    String.raw`(?<![A-Za-z0-9_])${CREDENTIAL_KEY}["']?\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)`,
    'gi',
  ),
  /\b[A-Fa-f0-9]{32,}\b/g,
]

/** Credential shapes strong enough to refuse an explicit memory write. */
const STRONG_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  new RegExp(SK_KEY_SOURCE),
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
]

/** Whether one already-split segment still carries a literal backslash. */
function hasUnsafeBackslashContext(segment: string): boolean {
  return segment.includes('\\')
}

/** Whether the original text carries unsafe code or path context. */
function hasUnsafeTextContext(text: string): boolean {
  if (/[A-Za-z]:\\/.test(text)) return true
  if (text.includes('```') || /`[^`]*\\[^`]*`/.test(text)) return true
  if (/[A-Za-z0-9_]\([^)]*\\[^)]*\)/.test(text)) return true
  // Mask literal CRLF escapes before looking for relative path tokens so
  // `Request\r\nfoo` is not read as `Request\` + `r\` + `nfoo`.
  const withoutCrlf = text.replace(/\\r\\n/g, ' ')
  return /(?:^|\s)(?:[A-Za-z0-9_.-]+\\){2,}[A-Za-z0-9_.-]+/.test(withoutCrlf)
}

/**
 * Restore escaped `\n` sequences in model-written memory text.
 *
 * Most conservative gate: split on literal `\r\n` / `\n`; only when there are
 * at least three separators, at least two `## ` headings, and no segment
 * retains a backslash, join the segments with real newlines. Any leftover
 * segment backslash or unsafe original context (Windows drive path, code fence,
 * inline code, relative path) makes the whole text return byte-for-byte
 * unchanged. Preserving the content is more important than restoring line
 * breaks.
 * @param text - Candidate title or body.
 * @returns Text with escaped newlines restored when appropriate.
 */
export function normalizeEscapedNewlines(text: string): string {
  if (text.includes('\n')) return text
  const segments = text.split(/\\(?:r\\n|n)/g)
  if (segments.length < 4 || text.split('## ').length - 1 < 2) return text
  if (segments.some((segment) => hasUnsafeBackslashContext(segment))) return text
  if (hasUnsafeTextContext(text)) return text
  return segments.join('\n')
}

/**
 * Detect credential shapes strong enough to refuse an explicit memory write.
 * This is stricter than {@link redactText} so ordinary prose such as `sk-learn`
 * or short tokens is not rejected.
 * @param text - Candidate title or body.
 * @returns Whether the text looks like a private key, API key or token.
 */
export function detectStrongSecret(text: string): boolean {
  return STRONG_SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Replace recognized secrets in one string.
 * @param text - Text to redact.
 * @returns Redacted text.
 */
export function redactText(text: string): string {
  let result = text
  for (const pattern of PATTERNS) result = result.replace(pattern, REDACTED)
  return result
}

/**
 * Redact one persistable text field and report whether it changed.
 * @param text - Field text.
 * @returns The redacted text and whether anything was replaced.
 */
export function redactField(text: string): { value: string; changed: boolean } {
  const value = redactText(text)
  return { value, changed: value !== text }
}

/**
 * Alias used by explicit-write paths: replace every recognized secret with
 * `[REDACTED]` before a value reaches the domain.
 * @param text - Text to redact.
 * @returns Redacted text.
 */
export function redactSecrets(text: string): string {
  return redactText(text)
}
