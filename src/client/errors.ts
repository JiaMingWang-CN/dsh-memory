/**
 * Localized presentation of one failed Remote call.
 *
 * The Host maps business failures onto stable `memory/*` codes
 * (`src/host/remote-errors.ts`); transport faults arrive as `gateway/*`.
 * Unknown codes keep the Host message for diagnosis.
 * @module dsh-memory/client/errors
 */
import { t } from './locales.ts'

/** Remote failure code → localized message key. */
const CODE_KEY: Record<string, string> = {
  'memory/conflict': 'error.conflict',
  'memory/not-found': 'error.notFound',
  'memory/invalid': 'error.invalid',
  'memory/forbidden': 'error.forbidden',
  'memory/capacity': 'error.capacity',
  'memory/unavailable': 'error.unavailable',
  'gateway/cancelled': 'error.cancelled',
  'client/timeout': 'error.timeout',
}

interface FailureLike {
  code?: unknown
  message?: unknown
  details?: { code?: unknown } | null
}

function failureOf(error: unknown): FailureLike | undefined {
  if (error === null || typeof error !== 'object') return undefined
  return error as FailureLike
}

/** Stable Remote failure code of one caught value, when it has one. */
export function remoteErrorCode(error: unknown): string | undefined {
  const code = failureOf(error)?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** Whether one failure is a concurrent-edit conflict. */
export function isConflict(error: unknown): boolean {
  return remoteErrorCode(error) === 'memory/conflict'
}

/**
 * Render one caught value for the user.
 * @param error - Caught Remote or local error.
 * @returns Localized text, falling back to the Host message.
 */
export function errorText(error: unknown): string {
  const code = remoteErrorCode(error)
  const key = code === undefined ? undefined : CODE_KEY[code]
  if (key !== undefined) return t(key)
  const message = failureOf(error)?.message
  return typeof message === 'string' && message !== '' ? message : t('error.unknown')
}
