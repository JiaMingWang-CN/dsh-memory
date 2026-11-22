import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient } from '../../scripts/build-client.mjs'
import { apply } from '../../src/client/index.ts'
import type { ClientContext, SlotRegistration } from '../../src/client/context.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface FakeClient {
  ctx: ClientContext
  sections: SlotRegistration[]
  icons: SlotRegistration[]
  mounted: unknown[]
}

function createFakeClient(): FakeClient {
  const sections: SlotRegistration[] = []
  const icons: SlotRegistration[] = []
  const mounted: unknown[] = []
  const ctx = {
    slots: {
      inject(_key: string, callback: () => () => void) {
        return callback()
      },
      register(registration: SlotRegistration) {
        if (registration.name === 'settings.section') sections.push(registration)
        else if (registration.name === 'settings.section.icon') icons.push(registration)
        return () => {}
      },
    },
    locale: {
      register() {
        return () => {}
      },
      bind() {
        return (key: string) => key
      },
    },
    remote: {
      memory: {},
      $mount(contribution: unknown) {
        mounted.push(contribution)
        return () => {}
      },
      $on() {
        return () => {}
      },
    },
  } as unknown as ClientContext
  return { ctx, sections, icons, mounted }
}

describe('client manifest', () => {
  it('declares the ./client export and the web client injection', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
      dsh: { client?: { platform?: string; immediately?: boolean; inject?: string[] } }
      files: string[]
    }
    expect(pkg.exports['./client']).toBe('./dist/client.js')
    expect(pkg.dsh.client?.platform).toBe('web')
    expect(pkg.dsh.client?.immediately).toBe(true)
    expect(pkg.files).toContain('dist/client.js')
  })
})

describe('client build', () => {
  it('emits a module-loader bundle with the package id', async () => {
    const { text } = await buildClient()
    expect(text.startsWith('window.__ModuleLoader__.load')).toBe(true)
    expect(text).toContain('id: "dsh-memory"')
    expect(text).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
})

describe('settings registration', () => {
  it('registers the memory section and matching icon at order 30', async () => {
    const client = createFakeClient()
    await apply(client.ctx)
    expect(client.sections).toHaveLength(1)
    expect(client.sections[0]).toMatchObject({ name: 'settings.section', id: 'memory', order: 30 })
    expect(client.icons).toHaveLength(1)
    expect(client.icons[0]).toMatchObject({
      name: 'settings.section.icon',
      id: 'memory',
      order: 30,
    })
    expect(client.mounted).toHaveLength(1)
    const contribution = client.mounted[0] as { package?: string; descriptors?: unknown[] }
    expect(contribution.package).toBe('dsh-memory')
    expect(contribution.descriptors).toHaveLength(21)
  })
})

describe('client lifecycle', () => {
  it('registers locale and slots through ctx.effect so a re-apply can dispose them', async () => {
    const disposers: Array<() => void> = []
    const namespaces = new Set<string>()
    const ctx = {
      slots: {
        inject(_key: string, callback: () => () => void) {
          return callback()
        },
        register() {
          return () => {}
        },
      },
      locale: {
        register(ns: string) {
          if (namespaces.has(ns)) throw new Error(`locale namespace "${ns}" is already registered`)
          namespaces.add(ns)
          return () => namespaces.delete(ns)
        },
        bind() {
          return (key: string) => key
        },
      },
      remote: {
        memory: {},
        $mount() {
          return () => {}
        },
        $on() {
          return () => {}
        },
      },
      effect(callback: () => void | (() => void)) {
        const dispose = callback()
        disposers.push(typeof dispose === 'function' ? dispose : () => {})
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      },
    } as unknown as ClientContext

    await apply(ctx)
    // Three effects own the locale dictionaries, the remote $mount handle, and the slot registrations.
    expect(disposers.length).toBe(3)
    // A fiber teardown disposes every registration before the next apply.
    for (const dispose of disposers) dispose()
    await expect(apply(ctx)).resolves.toBeUndefined()
  })
})

describe('locale metadata', () => {
  it('ships meta.title, meta.description and meta.detail in zh and en', () => {
    for (const file of ['locale/en.json', 'locale/zh.json']) {
      const doc = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as {
        meta?: { title?: string; description?: string; detail?: string }
      }
      expect(doc.meta?.title).toBeTruthy()
      expect(doc.meta?.description).toBeTruthy()
      expect(doc.meta?.detail).toBeTruthy()
    }
  })
})

describe('icon', () => {
  it('exists and is at most 256KiB', () => {
    const size = statSync(resolve(root, 'icon.svg')).size
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(256 * 1024)
  })
})
