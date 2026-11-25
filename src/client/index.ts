/**
 * Client entry for the Memloom bundle.
 *
 * The build script wraps the compiled module in
 * `window.__ModuleLoader__.load({ id: 'memloom', factory(require) {…} })`.
 * React comes from the browser module table through `require('react')`; this
 * module never imports a Harness Client package.
 * @module memloom/client
 */
import type { ClientContext } from './context.ts'
import { MemoryIcon } from './MemoryIcon.tsx'
import { MemorySection } from './MemorySection.tsx'
import { MemoryUsageAssistantAction } from './MemoryUsageText.tsx'
import { NS, en, setTranslate, zh } from './locales.ts'
import { MEMORY_REMOTE } from './remote-contract.ts'
import { clearClientContext, setClientContext, setRemoteMountError } from './runtime.ts'

/** Services this Client half needs before it activates. */
export const inject = ['slots', 'locale', 'remote'] as const

/**
 * Register the locale dictionaries and the Memory settings section plus icon.
 *
 * Registration is fiber-owned (`ctx.effect`): the locale service rejects a
 * second registration for the same namespace, so a hot client replacement or a
 * same-page disable/enable cycle must dispose the previous dictionaries with
 * the fiber that registered them.
 * @param ctx - Client context carrying `slots`, `locale` and `remote`.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  setClientContext(ctx)
  let disposed = false
  let unmountRemote: (() => void) | undefined

  const disposeContext = (): void => {
    disposed = true
    const unmount = unmountRemote
    unmountRemote = undefined
    unmount?.()
    clearClientContext(ctx)
  }
  ctx.effect?.(() => disposeContext)

  try {
    if (ctx.remote.$mount !== undefined) {
      const unmount = await ctx.remote.$mount(MEMORY_REMOTE)
      if (typeof unmount === 'function') {
        if (disposed) {
          unmount()
          return
        }
        unmountRemote = unmount
      }
    }
    if (disposed) return
    setRemoteMountError(undefined)
  } catch (error) {
    if (disposed) return
    setRemoteMountError(error instanceof Error ? error.message : String(error))
  }

  const bind = (): (() => void) => ctx.locale.register(NS, { zh, en })
  if (ctx.effect === undefined) bind()
  else ctx.effect(bind)

  const translate = ctx.locale.bind(NS)
  setTranslate(translate)
  const registerSlots = (): (() => void) => {
    const offSection = ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'memory',
          order: 30,
          label: () => translate('settings.title'),
        },
        MemorySection,
      ),
    )
    const offIcon = ctx.slots.inject('settings.section.icon', () =>
      ctx.slots.register({ name: 'settings.section.icon', id: 'memory', order: 30 }, MemoryIcon),
    )
    // A small session-memory note in the assistant action row, beside token
    // usage. The memory tools themselves keep DSH's native tool-call rows (no
    // custom `tool.call.toolview` entries), so they read like memory_read.
    const offUsage = ctx.slots.inject('conversation.chat.assistant-actions', () =>
      ctx.slots.register(
        { name: 'conversation.chat.assistant-actions', id: 'memory-usage', order: 50 },
        MemoryUsageAssistantAction,
      ),
    )
    return () => {
      offSection()
      offIcon()
      offUsage()
    }
  }
  if (ctx.effect === undefined) registerSlots()
  else ctx.effect(registerSlots)
}
