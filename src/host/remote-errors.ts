/**
 * Map Host business errors onto the Typert Remote failure contract.
 *
 * The Gateway forwards an owner-thrown `RemoteError` verbatim and folds every
 * other exception into `gateway/internal`, which erases the stable
 * `OperationError` code the Client branches on (for example a concurrent-edit
 * conflict). Wrapping the Remote methods turns each `OperationError` into a
 * `memory/*` failure whose `details.code` keeps the precise domain code.
 * @module dsh-memory/host/remote-errors
 */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ZodError } from 'zod'
import { OperationError, type OperationErrorCode } from './operations.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A revision or identity conflict; `code` carries the domain error code. */
    'memory/conflict': { readonly code: OperationErrorCode }
    /** The addressed record does not exist or is not visible. */
    'memory/not-found': { readonly code: OperationErrorCode }
    /** The request content or configuration is invalid. */
    'memory/invalid': { readonly code: OperationErrorCode }
    /** The caller may not perform this action (scope, confirmation, model). */
    'memory/forbidden': { readonly code: OperationErrorCode }
    /** A capacity limit refuses the write. */
    'memory/capacity': { readonly code: OperationErrorCode }
    /** The service is recovering or stopping. */
    'memory/unavailable': { readonly code: OperationErrorCode }
  }
}

/** Every failure code this namespace can send to the Client. */
export type MemoryRemoteErrorCode =
  | 'memory/conflict'
  | 'memory/not-found'
  | 'memory/invalid'
  | 'memory/forbidden'
  | 'memory/capacity'
  | 'memory/unavailable'

/** Domain code → Remote failure code. */
const REMOTE_CODE: Record<OperationErrorCode, MemoryRemoteErrorCode> = {
  MEMORY_CONFLICT: 'memory/conflict',
  MEMORY_NOT_FOUND: 'memory/not-found',
  MEMORY_INVALID_CONTENT: 'memory/invalid',
  MEMORY_INVALID_CONFIG: 'memory/invalid',
  MEMORY_INVALID_QUERY: 'memory/invalid',
  MEMORY_FORBIDDEN: 'memory/forbidden',
  MEMORY_FORBIDDEN_SCOPE: 'memory/forbidden',
  MEMORY_CONFIRM_REQUIRED: 'memory/forbidden',
  MEMORY_CAPACITY: 'memory/capacity',
  MEMORY_RECOVERING: 'memory/unavailable',
  MEMORY_STOPPED: 'memory/unavailable',
  MEMORY_UNAVAILABLE: 'memory/unavailable',
}

/** Marker kept on a wrapped method so re-registration cannot wrap twice. */
const BOUNDARY = Symbol.for('dsh-memory/remote-error-boundary')

/**
 * Translate one caught value into the wire failure the Client can branch on.
 * Non-business exceptions (storage faults, programming errors) stay untouched
 * so the Gateway still reports them as `gateway/internal`.
 * @param error - Caught value.
 * @returns The error to throw.
 */
export function toRemoteError(error: unknown): unknown {
  if ((error as { isDSHRemoteError?: unknown } | undefined)?.isDSHRemoteError === true) return error
  if (error instanceof OperationError) {
    return new RemoteError(REMOTE_CODE[error.code], error.message, { code: error.code })
  }
  if (error instanceof ZodError) {
    return new RemoteError('memory/invalid', error.issues[0]?.message ?? error.message, {
      code: 'MEMORY_INVALID_CONTENT',
    })
  }
  return error
}

/**
 * Wrap the listed prototype methods so every thrown business error keeps its
 * code across the Remote boundary. Dispatch keeps using the strict descriptors,
 * so the wrapper arity is never part of the wire signature; a synchronous
 * method stays synchronous because the page calls some of them in-process.
 * @param prototype - Class prototype holding the Remote implementations.
 * @param methods - Implementation method names.
 */
export function wrapRemoteBusinessErrors(
  prototype: Record<string, unknown>,
  methods: readonly string[],
): void {
  for (const method of methods) {
    const original = prototype[method]
    if (typeof original !== 'function') continue
    if ((original as unknown as Record<symbol, unknown>)[BOUNDARY] === true) continue
    const call = original as (...values: unknown[]) => unknown
    const wrapped = isAsyncFunction(original)
      ? async function (this: unknown, ...args: unknown[]): Promise<unknown> {
          try {
            return await call.apply(this, args)
          } catch (error) {
            throw toRemoteError(error)
          }
        }
      : function (this: unknown, ...args: unknown[]): unknown {
          try {
            return call.apply(this, args)
          } catch (error) {
            throw toRemoteError(error)
          }
        }
    Object.defineProperty(wrapped, BOUNDARY, { value: true })
    Object.defineProperty(wrapped, 'name', { value: original.name })
    prototype[method] = wrapped
  }
}

/** Whether a function was declared `async`, preserving sync return semantics. */
function isAsyncFunction(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object AsyncFunction]'
}
