/**
 * Unwrap a Typert Remote call result, with a bounded wait.
 *
 * Generated Client namespaces resolve to `RemoteResult<T>` (`{ ok, value }` or
 * `{ ok, error }`) rather than throwing on transport or Host failures. This
 * helper returns the value on success and throws the carried error, while also
 * accepting a plain value so tests can stub the namespace directly.
 *
 * A call that never settles would otherwise leave the page spinning forever,
 * so the wait is bounded: a stuck carrier surfaces a retryable error instead of
 * an infinite loading state.
 * @module dsh-memory/client/rpc
 */

interface RemoteSuccess<T> {
  ok: true
  value: T
}

interface RemoteFailureLike {
  ok: false
  error: unknown
}

/** Default upper bound for one management call. */
export const RPC_TIMEOUT_MS = 15_000

/**
 * Upper bound for a bulk transfer (import/export). A replace import can delete
 * and rewrite thousands of rows; timing it out at the interactive bound would
 * report a failure while the Host keeps going.
 */
export const RPC_BULK_TIMEOUT_MS = 120_000

/** A management call that produced no reply within its bound. */
export class RpcTimeoutError extends Error {
  /** Stable code so the page can localize the failure. */
  readonly code = 'client/timeout'

  constructor(message: string) {
    super(message)
    this.name = 'RpcTimeoutError'
  }
}

/**
 * Await one Remote call and return its value or throw its error.
 * @param call - The namespace method promise, in either envelope or plain form.
 * @param timeoutMs - Longest wait before failing; `0` disables the bound.
 * @returns The decoded value.
 */
export async function rpc<T>(
  call: Promise<T | RemoteSuccess<T> | RemoteFailureLike>,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result: unknown =
    timeoutMs > 0
      ? await Promise.race([
          call,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new RpcTimeoutError('memory service did not answer in time')),
              timeoutMs,
            )
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer)
        })
      : await call
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    const envelope = result as RemoteSuccess<T> | RemoteFailureLike
    if (envelope.ok) return envelope.value
    throw envelope.error
  }
  return result as T
}
