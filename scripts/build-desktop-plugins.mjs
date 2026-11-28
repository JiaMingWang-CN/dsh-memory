/**
 * Build the bundled plugins directory (`dist/desktop-bundled-plugins/`) for Memloom Desktop.
 *
 * Includes:
 * - `agy-plugin/`: self-contained AGY plugin directory via `buildAgyPlugin`
 * - `dsh-bundle/memloom-<version>.tgz`: deterministic DSH plugin bundle tarball
 * - `manifest.json`: version, file list, and SHA-256 digests
 *
 * Optionally emits a release-ready `memloom-agy-plugin-<version>.zip` and `SHA256SUMS.txt`.
 *
 * Usage: `node scripts/build-desktop-plugins.mjs`
 */
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { buildAgyPlugin } from './build-agy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutDir = resolve(root, 'dist/desktop-bundled-plugins')

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/**
 * Compute CRC-32 checksum for a buffer.
 * @param {Uint8Array} data
 * @returns {number}
 */
function crc32(data) {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Create a deterministic ZIP buffer from relative paths and raw bytes.
 * @param {ReadonlyArray<{ readonly relativePath: string; readonly data: Uint8Array }>} entries
 * @returns {Buffer}
 */
function createDeterministicZip(entries) {
  const sorted = [...entries]
    .map((entry) => ({
      name: entry.relativePath.replace(/\\/g, '/'),
      data: entry.data,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const localParts = []
  const centralParts = []
  let offset = 0
  const dosTime = 0x0000
  const dosDate = 0x0021
  const utf8Flag = 0x0800

  for (const item of sorted) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const rawBuf = Buffer.from(item.data.buffer, item.data.byteOffset, item.data.byteLength)
    const compressed = deflateRawSync(rawBuf)
    const checksum = crc32(rawBuf)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(utf8Flag, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(utf8Flag, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(rawBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + compressed.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(sorted.length, 8)
  eocd.writeUInt16LE(sorted.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, eocd])
}

/**
 * Format SHA256SUMS.txt lines in standard GNU `sha256sum` format.
 * @param {ReadonlyArray<{ readonly fileName: string; readonly sha256: string }>} entries
 * @returns {string}
 */
export function formatSha256Sums(entries) {
  const sorted = [...entries].sort((a, b) => a.fileName.localeCompare(b.fileName))
  return `${sorted.map((entry) => `${entry.sha256.toLowerCase()}  ${entry.fileName}`).join('\n')}\n`
}

/**
 * Pack the root DSH plugin tarball into a temporary directory without leaving `.tgz` in the repo root.
 * @param {string} destTgzPath
 */
async function packDshTarballTo(destTgzPath) {
  const tmpDir = await mkdtemp(resolve(os.tmpdir(), 'memloom-dsh-pack-'))
  try {
    if (process.platform === 'win32') {
      const comSpec = process.env.ComSpec || 'cmd.exe'
      const cmdLine = `""pnpm.cmd" pack --pack-destination "${tmpDir}""`
      execFileSync(comSpec, ['/d', '/s', '/c', cmdLine], {
        cwd: root,
        stdio: 'pipe',
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    } else {
      execFileSync('pnpm', ['pack', '--pack-destination', tmpDir], {
        cwd: root,
        stdio: 'pipe',
      })
    }
    const entries = await readdir(tmpDir)
    const tgzName = entries.find((name) => name.endsWith('.tgz'))
    if (!tgzName) {
      throw new Error('pnpm pack did not produce a .tgz archive')
    }
    await mkdir(dirname(destTgzPath), { recursive: true })
    await copyFile(resolve(tmpDir, tgzName), destTgzPath)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Build `dist/desktop-bundled-plugins/` and optional release ZIP + `SHA256SUMS.txt`.
 * @param {{ outDir?: string; dshTgzPath?: string; agyZipOutPath?: string; checksumsOutPath?: string }} [options]
 */
export async function buildDesktopBundledPlugins(options = {}) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = String(pkg.version)
  const outDir = options.outDir ? resolve(root, options.outDir) : defaultOutDir

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const agyDirName = 'agy-plugin'
  const agyOutDir = resolve(outDir, agyDirName)
  const agyBuilt = await buildAgyPlugin({ outDir: agyOutDir })
  const agyFiles = [...agyBuilt.files].sort()

  const agyHash = createHash('sha256')
  const zipEntries = []
  for (const rel of agyFiles) {
    const fileBytes = await readFile(resolve(agyOutDir, rel))
    agyHash.update(`${rel}\0`).update(fileBytes)
    if (options.agyZipOutPath) {
      zipEntries.push({ relativePath: rel, data: fileBytes })
    }
  }
  const agySha256 = agyHash.digest('hex')

  const dshRelFile = `dsh-bundle/memloom-${version}.tgz`
  const dshDestPath = resolve(outDir, dshRelFile)
  await mkdir(dirname(dshDestPath), { recursive: true })
  if (options.dshTgzPath) {
    await copyFile(resolve(root, options.dshTgzPath), dshDestPath)
  } else {
    await packDshTarballTo(dshDestPath)
  }

  const dshBytes = await readFile(dshDestPath)
  const dshSha256 = createHash('sha256').update(dshBytes).digest('hex')

  const manifest = {
    version,
    builtAt: new Date().toISOString(),
    agy: {
      dir: agyDirName,
      files: agyFiles,
      sha256: agySha256,
    },
    dsh: {
      file: dshRelFile,
      sha256: dshSha256,
    },
  }

  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )

  const checksumEntries = [{ fileName: basename(dshDestPath), sha256: dshSha256 }]

  let agyZipPath
  if (options.agyZipOutPath) {
    agyZipPath = resolve(root, options.agyZipOutPath)
    await mkdir(dirname(agyZipPath), { recursive: true })
    const zipBuffer = createDeterministicZip(zipEntries)
    await writeFile(agyZipPath, zipBuffer)
    const zipSha = createHash('sha256').update(zipBuffer).digest('hex')
    checksumEntries.push({ fileName: basename(agyZipPath), sha256: zipSha })
  }

  let checksumsPath
  if (options.checksumsOutPath) {
    checksumsPath = resolve(root, options.checksumsOutPath)
    await mkdir(dirname(checksumsPath), { recursive: true })
    await writeFile(checksumsPath, formatSha256Sums(checksumEntries), 'utf8')
  }

  return {
    outDir,
    manifest,
    ...(agyZipPath !== undefined ? { agyZipPath } : {}),
    ...(checksumsPath !== undefined ? { checksumsPath } : {}),
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await buildDesktopBundledPlugins()
  console.log(
    `built dist/desktop-bundled-plugins v${result.manifest.version} (${result.manifest.agy.files.length} AGY files + DSH tarball)`,
  )
}
