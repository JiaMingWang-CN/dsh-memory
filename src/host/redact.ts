/**
 * Re-export secret detection and redaction helpers from the shared core.
 * @module dsh-memory/host/redact
 */
export {
  detectStrongSecret,
  normalizeEscapedNewlines,
  redactField,
  redactSecrets,
  redactText,
} from '../core/redact.ts'
