/**
 * Build the self-contained Electron app payload under `dist/desktop-app/`.
 *
 * Bundles `src/desktop/main/index.ts` and `src/desktop/preload/index.ts` as
 * CommonJS modules (keeping `electron` external), bundles
 * `src/desktop/renderer/index.tsx` as a browser IIFE with React/ReactDOM
 * included, copies `index.html` and `theme.css`, generates a 256x256
 * PNG-in-ICO `assets/icon.ico` using pure Node `node:zlib`, and writes a
 * minimal `package.json` synced with the root version.
 *
 * Usage: `node scripts/build-desktop.mjs`
 */
import { build } from 'esbuild'
import { Buffer } from 'node:buffer'
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutDir = resolve(root, 'dist/desktop-app')

/**
 * Recursively list all files inside a directory as POSIX-relative paths.
 * @param {string} baseDir - Root directory to walk.
 * @param {string} [currentDir] - Current directory being visited.
 * @returns {Promise<string[]>} Sorted relative file paths.
 */
async function collectFiles(baseDir, currentDir = baseDir) {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const full = resolve(currentDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(baseDir, full)))
    } else if (entry.isFile()) {
      out.push(relative(baseDir, full).split('\\').join('/'))
    }
  }
  return out.sort()
}

/**
 * Ensure an entry file exists before bundling.
 * @param {string} entryRelative - Repo-relative entry path.
 * @returns {Promise<string>} Absolute entry path.
 */
async function requireEntry(entryRelative) {
  const entry = resolve(root, entryRelative)
  try {
    await access(entry)
  } catch {
    throw new Error(`Missing Desktop entrypoint: ${entryRelative}`)
  }
  return entry
}

/**
 * Compute standard CRC32 table for PNG chunk checksums.
 * @returns {Uint32Array}
 */
function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

const CRC_TABLE = buildCrcTable()

/**
 * Compute CRC32 over one byte buffer.
 * @param {Buffer} buf - Input bytes.
 * @returns {number} Unsigned 32-bit CRC.
 */
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a single PNG chunk (`length + type + data + crc`).
 * @param {string} type - 4-char ASCII chunk type.
 * @param {Buffer} data - Chunk payload.
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/**
 * Signed distance from a point to a line segment.
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * Signed distance to a rounded rectangle centered at `(cx, cy)`.
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} halfW
 * @param {number} halfH
 * @param {number} radius
 * @returns {number}
 */
function sdRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius)
  const qy = Math.abs(py - cy) - (halfH - radius)
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inDist = Math.min(Math.max(qx, qy), 0)
  return outDist + inDist - radius
}

/**
 * Blend one white anti-aliased shape alpha over the current RGBA pixel.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} shapeAlpha
 * @returns {[number, number, number]}
 */
function blendWhite(r, g, b, shapeAlpha) {
  const a = Math.max(0, Math.min(1, shapeAlpha))
  return [
    Math.round(r * (1 - a) + 255 * a),
    Math.round(g * (1 - a) + 255 * a),
    Math.round(b * (1 - a) + 255 * a),
  ]
}

/**
 * Render a 256x256 PNG-in-ICO buffer inspired by `icon.svg` using pure Node `zlib`.
 * @returns {Buffer}
 */
function createDesktopIconIco() {
  const size = 256
  const scale = size / 128
  const stride = 1 + size * 4
  const raw = Buffer.alloc(stride * size)

  const nodes = [
    [64, 34, 5],
    [50, 52, 4],
    [78, 52, 4],
    [48, 70, 4],
    [80, 70, 4],
    [64, 92, 4],
  ]
  const segments = [
    [64, 34, 64, 92],
    [50, 52, 58, 52],
    [70, 52, 78, 52],
    [48, 70, 56, 70],
    [72, 70, 80, 70],
    [64, 34, 48, 44],
    [48, 44, 44, 60],
    [44, 60, 48, 82],
    [48, 82, 64, 92],
    [64, 34, 80, 44],
    [80, 44, 84, 60],
    [84, 60, 80, 82],
    [80, 82, 64, 92],
  ]

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0
    for (let x = 0; x < size; x += 1) {
      const sx = (x + 0.5) / scale
      const sy = (y + 0.5) / scale
      const dist = sdRoundedRect(sx, sy, 64, 64, 60, 60, 26)
      const bgAlpha = Math.max(0, Math.min(1, 0.5 - dist))

      const pixelOffset = rowStart + 1 + x * 4
      if (bgAlpha <= 0) {
        raw[pixelOffset] = 0
        raw[pixelOffset + 1] = 0
        raw[pixelOffset + 2] = 0
        raw[pixelOffset + 3] = 0
        continue
      }

      const grad = Math.max(0, Math.min(1, (sx + sy) / 256))
      let r = Math.round(0x4f * (1 - grad) + 0x7a * grad)
      let g = Math.round(0x6d * (1 - grad) + 0x3f * grad)
      let b = Math.round(0xf5 * (1 - grad) + 0xf2 * grad)

      let strokeCov = 0
      for (const [ax, ay, bx, by] of segments) {
        const d = distanceToSegment(sx, sy, ax, ay, bx, by) - 2.0
        const cov = Math.max(0, Math.min(1, 0.5 - d)) * 0.95
        if (cov > strokeCov) strokeCov = cov
      }
      if (strokeCov > 0) {
        ;[r, g, b] = blendWhite(r, g, b, strokeCov)
      }

      let nodeCov = 0
      for (const [nx, ny, nr] of nodes) {
        const d = Math.hypot(sx - nx, sy - ny) - nr
        const cov = Math.max(0, Math.min(1, 0.5 - d))
        if (cov > nodeCov) nodeCov = cov
      }
      if (nodeCov > 0) {
        ;[r, g, b] = blendWhite(r, g, b, nodeCov)
      }

      raw[pixelOffset] = r
      raw[pixelOffset + 1] = g
      raw[pixelOffset + 2] = b
      raw[pixelOffset + 3] = Math.round(bgAlpha * 255)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(raw, { level: 9 })
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const png = Buffer.concat([
    pngSignature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)

  const entry = Buffer.alloc(16)
  entry[0] = 0
  entry[1] = 0
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)

  return Buffer.concat([header, entry, png])
}

/**
 * Build the self-contained Electron desktop app payload under `dist/desktop-app/`
 * (or a custom `outDir`).
 * @param {{ outDir?: string }} [options] - Optional build destination override.
 * @returns {Promise<{ outDir: string; files: string[] }>} Output directory and sorted relative files.
 */
export async function buildDesktopApp(options = {}) {
  const outDir = options.outDir ? resolve(root, options.outDir) : defaultOutDir

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await mkdir(resolve(outDir, 'renderer'), { recursive: true })
  await mkdir(resolve(outDir, 'assets'), { recursive: true })

  const mainEntry = await requireEntry('src/desktop/main/index.ts')
  const preloadEntry = await requireEntry('src/desktop/preload/index.ts')
  const localLauncherEntry = await requireEntry('src/desktop/local-launcher.ts')
  const localBridgeEntry = await requireEntry('src/desktop/local-bridge.ts')
  const rendererEntry = await requireEntry('src/desktop/renderer/index.tsx')
  const rendererHtml = await requireEntry('src/desktop/renderer/index.html')
  const rendererCss = await requireEntry('src/desktop/renderer/theme.css')

  await build({
    entryPoints: [mainEntry],
    outfile: resolve(outDir, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'warning',
  })

  await build({
    entryPoints: [preloadEntry],
    outfile: resolve(outDir, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'warning',
  })

  await build({
    entryPoints: [localLauncherEntry],
    outfile: resolve(outDir, 'local-launcher.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    logLevel: 'warning',
  })

  await build({
    entryPoints: [localBridgeEntry],
    outfile: resolve(outDir, 'renderer/local-bridge.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    sourcemap: false,
    logLevel: 'warning',
  })

  await build({
    entryPoints: [rendererEntry],
    outfile: resolve(outDir, 'renderer/index.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: false,
    logLevel: 'warning',
  })

  await copyFile(rendererHtml, resolve(outDir, 'renderer/index.html'))
  await copyFile(rendererCss, resolve(outDir, 'renderer/theme.css'))
  await writeFile(resolve(outDir, 'assets/icon.ico'), createDesktopIconIco())

  const rootPkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const desktopManifest = {
    name: 'memloom-desktop',
    version: rootPkg.version,
    main: './main.cjs',
    private: true,
  }
  await writeFile(
    resolve(outDir, 'package.json'),
    `${JSON.stringify(desktopManifest, null, 2)}\n`,
    'utf8',
  )

  const files = await collectFiles(outDir)
  return { outDir, files }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await buildDesktopApp()
  console.log(`built dist/desktop-app (${result.files.length} files)`)
}
