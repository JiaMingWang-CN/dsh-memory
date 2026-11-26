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
 * Point-in-polygon hit test using the even-odd ray-casting rule.
 * @param {number} px
 * @param {number} py
 * @param {ReadonlyArray<readonly [number, number]>} polygon
 * @returns {boolean}
 */
function pointInPolygon(px, py, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
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
 * Render a 256x256 PNG-in-ICO buffer matching the Warp & Weft M `icon.svg`
 * using 4x4 supersampling and pure Node `zlib`.
 * @returns {Buffer}
 */
function createDesktopIconIco() {
  const size = 256
  const stride = 1 + size * 4
  const raw = Buffer.alloc(stride * size)
  const subOffsets = [0.125, 0.375, 0.625, 0.875]

  const mLeftPoly = [
    [35, 28],
    [53, 28],
    [128, 157.9],
    [130.5, 153.5],
    [162.9, 153.5],
    [128, 213.9],
    [64.8, 104.5],
    [35, 104.5],
  ]
  const mRightPoly = [
    [203, 28],
    [221, 28],
    [221, 228],
    [193, 228],
    [193, 101.3],
    [191.2, 104.5],
    [158.8, 104.5],
  ]
  const weftLeftPoly = [
    [20, 117],
    [57.6, 117],
    [71.5, 141],
    [20, 141],
  ]
  const weftMidPoly = [
    [118.8, 117],
    [180.5, 117],
    [180.5, 141],
    [132.7, 141],
  ]

  const sampleColor = (sx, sy) => {
    if (sdRoundedRect(sx, sy, 128, 128, 128, 128, 57.6) > 0) {
      return null
    }
    const lx = (sx - 37.89) / 0.704
    const ly = (sy - 35.33) / 0.704

    if (
      (lx >= 35 && lx <= 63 && ly >= 153.5 && ly <= 228) ||
      pointInPolygon(lx, ly, mLeftPoly) ||
      pointInPolygon(lx, ly, mRightPoly)
    ) {
      return [255, 255, 255]
    }
    if (
      (lx <= 20 && (lx - 20) * (lx - 20) + (ly - 129) * (ly - 129) <= 144) ||
      pointInPolygon(lx, ly, weftLeftPoly) ||
      pointInPolygon(lx, ly, weftMidPoly) ||
      (lx >= 233.5 && lx <= 236 && ly >= 117 && ly <= 141) ||
      (lx >= 236 && (lx - 236) * (lx - 236) + (ly - 129) * (ly - 129) <= 144)
    ) {
      return [229, 122, 68]
    }
    return [24, 36, 48]
  }

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0
    for (let x = 0; x < size; x += 1) {
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let hits = 0
      for (const oy of subOffsets) {
        for (const ox of subOffsets) {
          const rgb = sampleColor(x + ox, y + oy)
          if (rgb !== null) {
            rSum += rgb[0]
            gSum += rgb[1]
            bSum += rgb[2]
            hits += 1
          }
        }
      }
      const pixelOffset = rowStart + 1 + x * 4
      if (hits === 0) {
        raw[pixelOffset] = 0
        raw[pixelOffset + 1] = 0
        raw[pixelOffset + 2] = 0
        raw[pixelOffset + 3] = 0
      } else {
        raw[pixelOffset] = Math.round(rSum / hits)
        raw[pixelOffset + 1] = Math.round(gSum / hits)
        raw[pixelOffset + 2] = Math.round(bSum / hits)
        raw[pixelOffset + 3] = Math.round((hits / 16) * 255)
      }
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
