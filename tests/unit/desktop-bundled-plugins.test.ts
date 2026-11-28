import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeterministicZip,
  extractZipSafely,
  resolveBundledPlugins,
  verifyBundledAgyFiles,
} from '../../src/desktop/bundled-plugins.ts'
import { buildDesktopBundledPlugins } from '../../scripts/build-desktop-plugins.mjs'
import { validateBundledPluginsArtifact } from '../../scripts/pack-desktop-check.mjs'

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function createFakeBundledRoot(version: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memloom-bundled-'))
  tmpDirs.push(root)
  const agyDir = path.join(root, 'agy-plugin')
  const dshDir = path.join(root, 'dsh-bundle')
  await fs.mkdir(agyDir, { recursive: true })
  await fs.mkdir(dshDir, { recursive: true })
  const pluginJson = JSON.stringify({ name: 'memloom', version })
  await fs.writeFile(path.join(agyDir, 'plugin.json'), pluginJson, 'utf8')
  const tgzName = `memloom-${version}.tgz`
  const tgzBuf = Buffer.from('fake-tgz-bytes')
  await fs.writeFile(path.join(dshDir, tgzName), tgzBuf)
  const dshSha = createHash('sha256').update(tgzBuf).digest('hex')
  const agySha = createHash('sha256').update('plugin.json\0').update(pluginJson).digest('hex')
  await fs.writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      version,
      builtAt: '2026-11-27T00:00:00.000Z',
      agy: { dir: 'agy-plugin', files: ['plugin.json'], sha256: agySha },
      dsh: { file: `dsh-bundle/${tgzName}`, sha256: dshSha },
    }),
    'utf8',
  )
  return root
}

describe('bundled-plugins resolver, zip safety, and artifact validation', () => {
  it('prefers resourcesPath/bundled-plugins over appDir sibling and enforces expectedVersion', async () => {
    const resRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memloom-res-'))
    tmpDirs.push(resRoot)
    const bundledSrc = await createFakeBundledRoot('0.2.3')
    await fs.cp(bundledSrc, path.join(resRoot, 'bundled-plugins'), { recursive: true })

    const matched = await resolveBundledPlugins({
      appDir: path.join(resRoot, 'app'),
      resourcesPath: resRoot,
      expectedVersion: '0.2.3',
    })
    expect(matched?.manifest.version).toBe('0.2.3')
    expect(matched?.dshTgzPath).toMatch(/memloom-0\.2\.3\.tgz$/)
    expect(await verifyBundledAgyFiles(matched!)).toEqual(['plugin.json'])

    const mismatched = await resolveBundledPlugins({
      appDir: path.join(resRoot, 'app'),
      resourcesPath: resRoot,
      expectedVersion: '0.2.4',
    })
    expect(mismatched).toBeNull()
  })

  it('builds real bundled plugins + AGY zip + SHA256SUMS and rejects Zip Slip / manifest traversal', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'memloom-real-bundled-'))
    tmpDirs.push(tmp)
    const fakeTgz = path.join(tmp, 'memloom-input.tgz')
    await fs.writeFile(fakeTgz, Buffer.from('tgz-payload'))
    const outDir = path.join(tmp, 'desktop-bundled-plugins')
    const agyZipOutPath = path.join(tmp, 'memloom-agy-plugin.zip')
    const checksumsOutPath = path.join(tmp, 'SHA256SUMS.txt')

    const built = await buildDesktopBundledPlugins({
      outDir,
      dshTgzPath: fakeTgz,
      agyZipOutPath,
      checksumsOutPath,
    })
    expect(validateBundledPluginsArtifact(outDir, built.manifest.version)).toEqual([])
    expect(validateBundledPluginsArtifact(outDir, '9.9.9').length).toBeGreaterThan(0)

    const extractedDir = path.join(tmp, 'extracted-agy')
    const extracted = await extractZipSafely(await fs.readFile(agyZipOutPath), extractedDir)
    expect(extracted).toContain('plugin.json')

    const evilZip = createDeterministicZip([
      { relativePath: '../escape.txt', data: Buffer.from('x') },
    ])
    await expect(extractZipSafely(evilZip, path.join(tmp, 'evil-out'))).rejects.toThrow()
  })
})
