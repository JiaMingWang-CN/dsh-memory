/**
 * Module-level handle to the live Client context.
 *
 * Slot components do not receive the Client context as a prop, so `apply`
 * stores it here once. Components read services through this accessor.
 * @module dsh-memory/client/runtime
 */
import * as React from 'react'
import type { ClientContext, MemoryRemote } from './context.ts'

let active: ClientContext | undefined
let mountFailure: string | undefined
let cachedRemote: MemoryRemote | undefined

/** Store the Client context captured during `apply`, dropping resolved caches. */
export function setClientContext(ctx: ClientContext): void {
  active = ctx
  cachedRemote = undefined
}

/** Clear the stored Client context on fiber disposal if it is still the active one. */
export function clearClientContext(expected?: ClientContext): void {
  if (expected !== undefined && active !== expected) return
  active = undefined
  cachedRemote = undefined
  mountFailure = undefined
}

/**
 * Subscribe to host locale changes so components re-render with updated copy.
 * No-ops safely when rendered without an applied Client context or subscribe API.
 */
export function useLocaleVersion(): number {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    let locale: ClientContext['locale'] | undefined
    try {
      locale = clientContext().locale
    } catch {
      return undefined
    }
    if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
    return locale.subscribe(() => setVersion((value) => value + 1))
  }, [])
  return version
}

/** Record why mounting the Remote contribution failed, if it did. */
export function setRemoteMountError(message: string | undefined): void {
  mountFailure = message
}

/** Read the Remote mount failure, if any. */
export function remoteMountError(): string | undefined {
  return mountFailure
}

/** Read the active Client context, failing loudly if the plugin never applied. */
export function clientContext(): ClientContext {
  if (active === undefined) {
    throw new Error('dsh-memory Client context is not available')
  }
  return active
}

/**
 * Read the mounted `remote.memory` namespace.
 *
 * Two Cordis details matter here. A plugin fiber may only read a service it
 * declares in `inject`, and the nested namespace is created after activation by
 * `$mount`, so a direct property read throws; `ctx.get` reads provided services
 * without that requirement. More importantly, `ctx.get` wraps the value in a
 * fresh tracing Proxy on every call, so the identity changes on every read. A
 * React effect that depends on the namespace must therefore see one stable
 * object, or it re-runs forever; cache the first resolved namespace here.
 * @returns The mounted memory Remote namespace.
 */
export function memoryRemote(): MemoryRemote {
  if (cachedRemote !== undefined) return cachedRemote
  const ctx = clientContext()
  const direct = ctx.get?.('remote.memory')
  if (direct !== undefined && direct !== null) {
    cachedRemote = direct as MemoryRemote
    return cachedRemote
  }
  return ctx.remote.memory
}
