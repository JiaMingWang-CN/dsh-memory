import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8')

interface PackageManifest {
  name: string
  version: string
  private: boolean
  type: string
  engines: { node: string; dsh: string }
  files: string[]
  exports: Record<string, string>
  dsh: { bundle: { patch: string } }
  scripts: Record<string, string>
  peerDependencies: Record<string, string>
}

const manifest = JSON.parse(read('package.json')) as PackageManifest

describe('bundle manifest', () => {
  it('declares the expected package identity and entry', () => {
    expect(manifest.name).toBe('memloom')
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.private).toBe(true)
    expect(manifest.type).toBe('module')
    expect(manifest.engines.node).toBe('>=24.9.0')
    // The DSH range is the authoritative compatibility statement; an exact
    // peer pin alone would mark the bundle incompatible on the next patch.
    expect(manifest.engines.dsh).toBe('^0.2.2-rc.5')
    expect(manifest.exports['.']).toBe('./dist/host/index.js')
  })

  it('builds before a package is produced', () => {
    expect(manifest.scripts.prepack).toBe('pnpm build')
  })

  it('declares only the DSH peers the Host really imports', () => {
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-storage')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-tools']).toBe('^0.2.2-rc.5')
    expect(manifest.peerDependencies['@deepseek-ai/cordis']).toBe('~4.1.0')
  })

  it('declares the bundle patch and packs every runtime resource', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    // `files` lists dist globs (so source maps stay out); at least one dist
    // pattern must be present alongside the other runtime resources.
    expect(manifest.files.some((entry) => entry === 'dist' || entry.startsWith('dist/'))).toBe(true)
    for (const entry of ['cordis.patch.yml', 'locale', 'docs/DETAIL.md', 'icon.svg']) {
      expect(manifest.files).toContain(entry)
    }
  })

  it('inserts a single memloom service row', () => {
    const patch = read('cordis.patch.yml')
    expect(patch).toContain('id: memloom')
    expect(patch).toContain('name: memloom')
  })

  it('provides bilingual metadata and an existing detail document', () => {
    for (const locale of ['en', 'zh']) {
      const meta = (JSON.parse(read(`locale/${locale}.json`)) as { meta?: Record<string, string> })
        .meta
      expect(meta?.title, `${locale} title`).toBeTruthy()
      expect(meta?.description, `${locale} description`).toBeTruthy()
      expect(meta?.detail, `${locale} detail`).toBe('docs/DETAIL.md')
    }
    expect(statSync(join(root, 'docs/DETAIL.md')).size).toBeGreaterThan(0)
  })

  it('ships an original SVG icon within the size limit', () => {
    const size = statSync(join(root, 'icon.svg')).size
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThanOrEqual(256 * 1024)
    expect(read('icon.svg').trimStart().startsWith('<svg')).toBe(true)
  })
})
