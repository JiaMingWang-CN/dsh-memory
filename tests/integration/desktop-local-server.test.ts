import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEdgeLaunchArgs } from '../../src/desktop/local-launcher.ts'
import { startLocalDesktopServer } from '../../src/desktop/local-server.ts'
import type { DialogAdapter } from '../../src/desktop/main/ipc-handlers.ts'
import { MultiClientService } from '../../src/desktop/multi-service.ts'
import type { PlatformAdapter } from '../../src/desktop/platform/types.ts'
import { ClientRegistry } from '../../src/desktop/registry.ts'
import { WriteGuard } from '../../src/desktop/write-guard.ts'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

function createStubEnv(): {
  rendererDir: string
  assetsDir: string
  service: MultiClientService
  dialog: DialogAdapter
  pickedPath: string
} {
  const root = makeTempDir('memloom-local-srv-')
  const rendererDir = join(root, 'renderer')
  const assetsDir = join(root, 'assets')
  mkdirSync(rendererDir, { recursive: true })
  mkdirSync(assetsDir, { recursive: true })
  writeFileSync(
    join(rendererDir, 'index.html'),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'none';" /></head><body><div id="root"></div><script defer src="./index.js"></script></body></html>`,
  )
  writeFileSync(join(rendererDir, 'index.js'), 'console.log("ok");')
  writeFileSync(join(rendererDir, 'local-bridge.js'), 'console.log("bridge");')
  writeFileSync(join(rendererDir, 'theme.css'), ':root {}')
  writeFileSync(join(assetsDir, 'icon.ico'), Buffer.from([0, 0, 1, 0, 1, 0]))

  const agyPath = join(root, 'agy', 'memory.json')
  const dshPath = join(root, 'dsh', 'storages', 'memory.json')
  const pickedPath = join(root, 'custom', 'memory.json')

  const platform: PlatformAdapter = {
    platform: 'win32',
    detectDshProcesses: async () => ({ running: false, uncertain: false, matchedProcesses: [] }),
    resolveDefaultDshStores: async () => [
      { id: 'dsh-default', name: 'DSH', kind: 'dsh', storePath: dshPath },
    ],
    resolveDefaultAgyStore: async () => ({
      primary: { id: 'agy-default', name: 'AGY', kind: 'agy', storePath: agyPath },
    }),
  }
  const registry = new ClientRegistry({
    statePath: join(root, 'desktop-state.json'),
    platform,
  })
  const writeGuard = new WriteGuard(platform)
  const service = new MultiClientService({ registry, writeGuard })

  const dialog: DialogAdapter = {
    pickMemoryFile: async () => pickedPath,
    pickDirectory: async () => join(root, 'ws'),
    pickImportJson: async () => null,
    saveExportJson: async () => null,
    pickDshCli: async () => null,
  }

  return { rendererDir, assetsDir, service, dialog, pickedPath }
}

describe('local desktop server (signed runtime bridge)', () => {
  it('injects session token and local-bridge.js in GET / and enforces token + same-origin on /api/invoke', async () => {
    const env = createStubEnv()
    await env.service.initialize()
    const server = await startLocalDesktopServer({
      rendererDir: env.rendererDir,
      assetsDir: env.assetsDir,
      service: env.service,
      dialog: env.dialog,
      appInfo: {
        version: '0.2.2',
        platform: 'win32',
        runtimeMode: 'local-bridge',
        bundledPluginsAvailable: false,
      },
    })

    try {
      const htmlRes = await fetch(server.url)
      expect(htmlRes.status).toBe(200)
      const html = await htmlRes.text()
      expect(html).toContain(`<meta name="memloom-session-token" content="${server.token}" />`)
      expect(html).toContain('<script defer src="./local-bridge.js"></script>')
      expect(html).toContain("connect-src 'self'")

      // Missing token -> 403
      const noToken = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'clients:list' }),
      })
      expect(noToken.status).toBe(403)

      // Wrong token -> 403
      const badToken = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': 'wrong-token',
        },
        body: JSON.stringify({ channel: 'clients:list' }),
      })
      expect(badToken.status).toBe(403)

      // Spoofed cross-origin -> 403
      const crossOrigin = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ channel: 'clients:list' }),
      })
      expect(crossOrigin.status).toBe(403)

      // Authenticated clients:list -> 200 ok
      const listRes = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
        },
        body: JSON.stringify({ channel: 'clients:list' }),
      })
      expect(listRes.status).toBe(200)
      const listJson = (await listRes.json()) as { ok: boolean; value?: unknown[] }
      expect(listJson.ok).toBe(true)
      expect(Array.isArray(listJson.value)).toBe(true)

      // Authenticated memory:create & aggregate:search
      const createRes = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
        },
        body: JSON.stringify({
          channel: 'memory:create',
          payload: {
            clientId: 'agy-default',
            type: 'preference',
            scope: 'global',
            title: 'Signed runtime pref',
            body: 'Works under Smart App Control',
          },
        }),
      })
      expect(createRes.status).toBe(200)
      expect(((await createRes.json()) as { ok: boolean }).ok).toBe(true)

      const searchRes = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
        },
        body: JSON.stringify({
          channel: 'aggregate:search',
          payload: { query: 'Smart App Control' },
        }),
      })
      const searchJson = (await searchRes.json()) as {
        ok: boolean
        value?: { items: Array<{ record: { title: string } }> }
      }
      expect(searchJson.ok).toBe(true)
      expect(searchJson.value?.items[0]?.record.title).toBe('Signed runtime pref')

      // Unauthorized arbitrary path -> memory/forbidden
      const unauthAdd = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
        },
        body: JSON.stringify({
          channel: 'clients:add',
          payload: { name: 'Evil', storePath: 'C:\\Windows\\System32\\evil.json' },
        }),
      })
      const unauthJson = (await unauthAdd.json()) as { ok: boolean; error?: { code: string } }
      expect(unauthJson.ok).toBe(false)
      expect(unauthJson.error?.code).toBe('memory/forbidden')

      // Invalid args -> desktop/invalid-args
      const invalidArgs = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
        },
        body: JSON.stringify({
          channel: 'memory:overview',
          payload: { clientId: '' },
        }),
      })
      const invalidJson = (await invalidArgs.json()) as { ok: boolean; error?: { code: string } }
      expect(invalidJson.ok).toBe(false)
      expect(invalidJson.error?.code).toBe('desktop/invalid-args')

      // app:getInfo exposes runtimeMode === 'local-bridge'
      const infoRes = await fetch(`${server.url}api/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Memloom-Token': server.token,
        },
        body: JSON.stringify({ channel: 'app:getInfo' }),
      })
      const infoJson = (await infoRes.json()) as {
        ok: boolean
        value?: { runtimeMode: string; bundledPluginsAvailable: boolean }
      }
      expect(infoJson.ok).toBe(true)
      expect(infoJson.value?.runtimeMode).toBe('local-bridge')
    } finally {
      await server.close()
      await env.service.closeAll()
    }
  })

  it('builds Edge --app launch flags with foreground window and background-mode disabled', () => {
    const args = buildEdgeLaunchArgs('http://127.0.0.1:51234/', 'C:/temp/edge-profile')
    expect(args).toEqual([
      '--app=http://127.0.0.1:51234/',
      '--user-data-dir=C:/temp/edge-profile',
      '--window-size=1280,840',
      '--new-window',
      '--disable-extensions',
      '--disable-background-mode',
      '--no-first-run',
      '--no-default-browser-check',
    ])
  })
})
