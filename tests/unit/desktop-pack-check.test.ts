import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- scripts/build-desktop.mjs has no .d.mts companion inside Task 8 file boundary
import { buildDesktopApp as rawBuildDesktopApp } from '../../scripts/build-desktop.mjs'
import { validateDesktopArtifact } from '../../scripts/pack-desktop-check.mjs'
import { validateManifest } from '../../scripts/pack-check.mjs'

const buildDesktopApp = rawBuildDesktopApp as (options?: {
  outDir?: string
}) => Promise<{ outDir: string; files: string[] }>

const root = fileURLToPath(new URL('../../', import.meta.url))
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeArtifactFile(baseDir: string, relative: string, content: string | Buffer): void {
  const full = join(baseDir, ...relative.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function createMinimalValidArtifact(baseDir: string): void {
  writeArtifactFile(
    baseDir,
    'package.json',
    JSON.stringify({
      name: 'memloom-desktop',
      version: '0.2.2',
      main: './main.cjs',
      private: true,
    }),
  )
  writeArtifactFile(baseDir, 'main.cjs', 'console.log("main");')
  writeArtifactFile(baseDir, 'preload.cjs', 'console.log("preload");')
  writeArtifactFile(baseDir, 'local-launcher.mjs', 'console.log("launcher");')
  writeArtifactFile(baseDir, 'renderer/index.html', '<!doctype html><html></html>')
  writeArtifactFile(baseDir, 'renderer/index.js', 'console.log("renderer");')
  writeArtifactFile(baseDir, 'renderer/local-bridge.js', 'console.log("bridge");')
  writeArtifactFile(baseDir, 'renderer/theme.css', ':root {}')
  writeArtifactFile(baseDir, 'assets/icon.ico', Buffer.from([0, 0, 1, 0, 1, 0]))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('desktop packaging and isolation checks', () => {
  it('flags missing required files in validateDesktopArtifact', () => {
    const dir = makeTempDir('memloom-desktop-missing-')
    writeArtifactFile(dir, 'package.json', '{"name":"memloom-desktop","main":"./main.cjs"}')
    const problems = validateDesktopArtifact(dir)
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('main.cjs'),
        expect.stringContaining('preload.cjs'),
        expect.stringContaining('local-launcher.mjs'),
        expect.stringContaining('renderer/index.html'),
        expect.stringContaining('renderer/index.js'),
        expect.stringContaining('renderer/local-bridge.js'),
        expect.stringContaining('renderer/theme.css'),
        expect.stringContaining('assets/icon.ico'),
      ]),
    )
  })

  it('flags forbidden files, sourcemaps, private docs, and @deepseek-ai imports', () => {
    const dir = makeTempDir('memloom-desktop-forbidden-')
    createMinimalValidArtifact(dir)
    writeArtifactFile(dir, 'main.cjs', 'const x = require("@deepseek-ai/cordis");')
    writeArtifactFile(dir, 'preload.cjs', 'const y = "@deepseek-ai/dsh-tools";')
    writeArtifactFile(dir, 'main.cjs.map', '{}')
    writeArtifactFile(dir, 'bundle.tgz', 'tgz')
    writeArtifactFile(dir, 'src/leak.ts', '')
    writeArtifactFile(dir, 'tests/leak.test.ts', '')
    writeArtifactFile(dir, 'node_modules/foo/index.js', '')
    writeArtifactFile(dir, 'AGENTS.md', '# private')
    writeArtifactFile(dir, 'CLAUDE.md', '# private')
    writeArtifactFile(dir, 'docs/specs/spec.md', '# private')
    writeArtifactFile(dir, 'docs/plans/plan.md', '# private')
    writeArtifactFile(dir, 'docs/release-checklist.md', '# private')

    const problems = validateDesktopArtifact(dir)
    expect(problems.some((p) => p.includes('main.cjs.map'))).toBe(true)
    expect(problems.some((p) => p.includes('bundle.tgz'))).toBe(true)
    expect(problems.some((p) => p.includes('src/leak.ts'))).toBe(true)
    expect(problems.some((p) => p.includes('tests/leak.test.ts'))).toBe(true)
    expect(problems.some((p) => p.includes('node_modules/foo/index.js'))).toBe(true)
    expect(problems.some((p) => p.includes('AGENTS.md'))).toBe(true)
    expect(problems.some((p) => p.includes('CLAUDE.md'))).toBe(true)
    expect(problems.some((p) => p.includes('docs/specs/spec.md'))).toBe(true)
    expect(problems.some((p) => p.includes('docs/plans/plan.md'))).toBe(true)
    expect(problems.some((p) => p.includes('docs/release-checklist.md'))).toBe(true)
    expect(problems.some((p) => p.includes('main.cjs') && p.includes('@deepseek-ai/'))).toBe(true)
    expect(problems.some((p) => p.includes('preload.cjs') && p.includes('@deepseek-ai/'))).toBe(
      true,
    )
  })

  it('builds a valid desktop artifact with 256x256 PNG-in-ICO and zero validation problems', async () => {
    const tempRoot = makeTempDir('memloom-desktop-build-')
    const outDir = join(tempRoot, 'desktop-app')
    const result = await buildDesktopApp({ outDir })

    expect(result.outDir).toBe(outDir)
    expect(result.files).toEqual(
      expect.arrayContaining([
        'package.json',
        'main.cjs',
        'preload.cjs',
        'local-launcher.mjs',
        'renderer/index.html',
        'renderer/index.js',
        'renderer/local-bridge.js',
        'renderer/theme.css',
        'assets/icon.ico',
      ]),
    )
    expect(result.files.some((file) => file.endsWith('.map'))).toBe(false)

    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    const desktopPkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as {
      name: string
      version: string
      main: string
      private: boolean
    }
    expect(desktopPkg).toEqual({
      name: 'memloom-desktop',
      version: rootPkg.version,
      main: './main.cjs',
      private: true,
    })

    const ico = readFileSync(join(outDir, 'assets/icon.ico'))
    // ICO header: reserved=0, type=1, count>=1; entry 0: width=0 (256), height=0 (256)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1)
    expect(ico.readUInt8(6)).toBe(0)
    expect(ico.readUInt8(7)).toBe(0)
    const imageOffset = ico.readUInt32LE(18)
    expect(ico.subarray(imageOffset, imageOffset + 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )

    expect(validateDesktopArtifact(outDir)).toEqual([])
  }, 30_000)

  it('rejects desktop/ and dist/desktop-* paths in root DSH pack-check validateManifest', () => {
    const baseFiles = [
      'package.json',
      'cordis.patch.yml',
      'dist/client.js',
      'dist/host/index.js',
      'locale/zh.json',
      'locale/en.json',
      'icon.svg',
      'docs/DETAIL.md',
    ]
    const problems = validateManifest({
      files: [
        ...baseFiles.map((path) => ({ path })),
        { path: 'desktop/package.json' },
        { path: 'desktop/electron-builder.yml' },
        { path: 'dist/desktop-app/main.cjs' },
        { path: 'dist/desktop-release/memloom-desktop-0.2.2-win-x64-setup.exe' },
      ],
    })
    expect(problems).toContain('forbidden file: desktop/package.json')
    expect(problems).toContain('forbidden file: desktop/electron-builder.yml')
    expect(problems).toContain('forbidden file: dist/desktop-app/main.cjs')
    expect(problems).toContain(
      'forbidden file: dist/desktop-release/memloom-desktop-0.2.2-win-x64-setup.exe',
    )
  })

  it('configures desktop/electron-builder.yml and desktop/package.json for Windows NSIS installer while preserving user data', () => {
    const builderCfg = readFileSync(join(root, 'desktop/electron-builder.yml'), 'utf8')
    const nsiScript = readFileSync(join(root, 'desktop/resources/installer.nsi'), 'utf8')
    const desktopPkg = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(builderCfg).toContain('target: nsis')
    expect(builderCfg).toContain('script: ./resources/installer.nsi')
    expect(builderCfg).toContain('deleteAppDataOnUninstall: false')
    expect(builderCfg).toContain('artifactName: memloom-desktop-${version}-win-${arch}-setup.exe')
    expect(nsiScript).toContain('WriteUninstaller')
    expect(nsiScript).toContain('Nsis7z::Extract')
    expect(desktopPkg.scripts?.['pack:win']).toContain('--win nsis')
  })
})
