import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { z } from 'zod'

export interface BundledPluginsManifest {
  readonly version: string
  readonly builtAt: string
  readonly agy: {
    readonly dir: string
    readonly files: readonly string[]
    readonly sha256: string
  }
  readonly dsh: {
    readonly file: string
    readonly sha256: string
  }
}

export interface ResolvedBundledPlugins {
  readonly rootDir: string
  readonly manifest: BundledPluginsManifest
  readonly agyDir: string
  readonly dshTgzPath: string
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/

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

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Validate that a relative archive/manifest path cannot escape its root directory.
 */
export function isSafeRelativePath(rawPath: string, allowTrailingSlash = false): boolean {
  if (rawPath.length === 0 || rawPath.includes('\0')) {
    return false
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\') || WINDOWS_DRIVE_RE.test(rawPath)) {
    return false
  }
  const normalized = rawPath.replace(/\\/g, '/')
  const trimmed =
    allowTrailingSlash && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  if (trimmed.length === 0) {
    return false
  }
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes(':')) {
      return false
    }
  }
  return true
}

const safeRelativePathSchema = z
  .string()
  .min(1)
  .refine((val) => isSafeRelativePath(val, false), { message: 'Unsafe relative path' })

const bundledPluginsManifestSchema = z.object({
  version: z.string().min(1),
  builtAt: z.string().min(1),
  agy: z.object({
    dir: safeRelativePathSchema,
    files: z.array(safeRelativePathSchema).min(1),
    sha256: z.string().regex(SHA256_HEX_RE),
  }),
  dsh: z.object({
    file: safeRelativePathSchema,
    sha256: z.string().regex(SHA256_HEX_RE),
  }),
})

function resolveWithinRoot(rootDir: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath, false)) {
    throw new Error(`Unsafe relative path: ${relativePath}`)
  }
  const resolvedRoot = path.resolve(rootDir)
  const target = path.resolve(resolvedRoot, ...relativePath.replace(/\\/g, '/').split('/'))
  const rel = path.relative(resolvedRoot, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes root directory: ${relativePath}`)
  }
  return target
}

/**
 * Create a deterministic ZIP archive buffer using pure Node `node:zlib` (deflate).
 */
export function createDeterministicZip(
  entries: ReadonlyArray<{ readonly relativePath: string; readonly data: Uint8Array }>,
): Buffer {
  const sorted = [...entries]
    .map((entry) => ({
      name: entry.relativePath.replace(/\\/g, '/'),
      data: entry.data,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  // Fixed DOS timestamp: 1980-01-01 00:00:00
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
    localHeader.writeUInt16LE(20, 4) // version needed: 2.0
    localHeader.writeUInt16LE(utf8Flag, 6)
    localHeader.writeUInt16LE(8, 8) // method: deflate
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra field length

    localParts.push(localHeader, nameBuf, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(utf8Flag, 8)
    centralHeader.writeUInt16LE(8, 10) // method: deflate
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(rawBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra length
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
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

interface ParsedZipEntry {
  readonly name: string
  readonly isDirectory: boolean
  readonly compressionMethod: number
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

function findEocdOffset(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20)
      if (i + 22 + commentLen === buf.length) {
        return i
      }
    }
  }
  return -1
}

/**
 * Safely extract a ZIP archive into `destDir` using pure Node `node:zlib`.
 * Validates every entry against Zip Slip (`..`, absolute paths, drive letters) before writing any file.
 */
export async function extractZipSafely(
  zipBytes: Uint8Array,
  destDir: string,
): Promise<readonly string[]> {
  const buf = Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength)
  if (buf.length < 22) {
    throw new Error('Invalid ZIP archive: too small')
  }

  const eocdOffset = findEocdOffset(buf)
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: End of Central Directory not found')
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)

  if (centralOffset + centralSize > eocdOffset) {
    throw new Error('Invalid ZIP archive: Central Directory out of bounds')
  }

  const resolvedDest = path.resolve(destDir)
  const entries: ParsedZipEntry[] = []
  let cursor = centralOffset

  // First pass: parse and validate every entry before touching the filesystem
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > centralOffset + centralSize) {
      throw new Error('Invalid ZIP archive: truncated Central Directory header')
    }
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: invalid Central Directory signature')
    }

    const compressionMethod = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const externalAttr = buf.readUInt32LE(cursor + 38)
    const localHeaderOffset = buf.readUInt32LE(cursor + 42)

    const nameEnd = cursor + 46 + nameLen
    const nextCursor = nameEnd + extraLen + commentLen
    if (nextCursor > centralOffset + centralSize) {
      throw new Error('Invalid ZIP archive: Central Directory entry out of bounds')
    }

    // Reject UNIX symlinks (mode 0120000 in upper 16 bits of external attributes)
    const unixMode = (externalAttr >>> 16) & 0o170000
    if (unixMode === 0o120000) {
      throw new Error('Unsafe ZIP entry: symbolic links are not allowed')
    }

    const rawName = buf.subarray(cursor + 46, nameEnd).toString('utf8')
    const normalizedName = rawName.replace(/\\/g, '/')
    const isDirectory = normalizedName.endsWith('/')

    if (!isSafeRelativePath(normalizedName, true)) {
      throw new Error(`Unsafe ZIP entry path (Zip Slip blocked): ${rawName}`)
    }
    const targetCheck = path.resolve(
      resolvedDest,
      ...(isDirectory ? normalizedName.slice(0, -1) : normalizedName).split('/'),
    )
    const relCheck = path.relative(resolvedDest, targetCheck)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`Unsafe ZIP entry escapes destination: ${rawName}`)
    }

    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${rawName}`)
    }

    entries.push({
      name: normalizedName,
      isDirectory,
      compressionMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })

    cursor = nextCursor
  }

  // Second pass: extract validated entries
  await fs.mkdir(resolvedDest, { recursive: true })
  const extractedFiles: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory) {
      const dirPath = path.resolve(resolvedDest, ...entry.name.slice(0, -1).split('/'))
      await fs.mkdir(dirPath, { recursive: true })
      continue
    }

    const lh = entry.localHeaderOffset
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local file header for ${entry.name}`)
    }
    const localNameLen = buf.readUInt16LE(lh + 26)
    const localExtraLen = buf.readUInt16LE(lh + 28)
    const dataStart = lh + 30 + localNameLen + localExtraLen
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > buf.length) {
      throw new Error(`Truncated ZIP data for ${entry.name}`)
    }

    const compressedSlice = buf.subarray(dataStart, dataEnd)
    const content =
      entry.compressionMethod === 0 ? Buffer.from(compressedSlice) : inflateRawSync(compressedSlice)

    if (content.length !== entry.uncompressedSize) {
      throw new Error(`ZIP size mismatch for ${entry.name}`)
    }
    if (crc32(content) !== entry.crc) {
      throw new Error(`ZIP CRC32 mismatch for ${entry.name}`)
    }

    const filePath = path.resolve(resolvedDest, ...entry.name.split('/'))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content)
    extractedFiles.push(entry.name)
  }

  return extractedFiles.sort()
}

/**
 * Verify every declared AGY file exists inside `resolved.agyDir` and matches `manifest.agy.sha256`.
 */
export async function verifyBundledAgyFiles(
  resolved: ResolvedBundledPlugins,
): Promise<readonly string[]> {
  const sortedFiles = [...resolved.manifest.agy.files].sort()
  const hash = createHash('sha256')

  for (const rel of sortedFiles) {
    const filePath = resolveWithinRoot(resolved.agyDir, rel)
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      throw new Error(`Bundled AGY entry is not a regular file: ${rel}`)
    }
    const bytes = await fs.readFile(filePath)
    hash.update(`${rel.replace(/\\/g, '/')}\0`).update(bytes)
  }

  const actualSha = hash.digest('hex')
  if (actualSha.toLowerCase() !== resolved.manifest.agy.sha256.toLowerCase()) {
    throw new Error(
      `Bundled AGY sha256 mismatch: expected ${resolved.manifest.agy.sha256}, got ${actualSha}`,
    )
  }

  return sortedFiles
}

async function tryLoadBundledRoot(
  candidateRoot: string,
  expectedVersion?: string,
): Promise<ResolvedBundledPlugins | null> {
  const manifestPath = path.join(candidateRoot, 'manifest.json')
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return null
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return null
  }

  const parsed = bundledPluginsManifestSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return null
  }

  const manifest: BundledPluginsManifest = parsed.data
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    return null
  }

  try {
    const agyDir = resolveWithinRoot(candidateRoot, manifest.agy.dir)
    const dshTgzPath = resolveWithinRoot(candidateRoot, manifest.dsh.file)
    const [agyStat, dshStat] = await Promise.all([fs.stat(agyDir), fs.stat(dshTgzPath)])
    if (!agyStat.isDirectory() || !dshStat.isFile()) {
      return null
    }
    const dshBytes = await fs.readFile(dshTgzPath)
    const dshSha = createHash('sha256').update(dshBytes).digest('hex')
    if (dshSha.toLowerCase() !== manifest.dsh.sha256.toLowerCase()) {
      return null
    }
    return {
      rootDir: path.resolve(candidateRoot),
      manifest,
      agyDir,
      dshTgzPath,
    }
  } catch {
    return null
  }
}

/**
 * Resolve bundled plugins directory with priority:
 * 1. Electron packaged: `path.join(resourcesPath, 'bundled-plugins')`
 * 2. Local dev / `start:desktop`: `path.resolve(appDir, '..', 'desktop-bundled-plugins')`
 */
export async function resolveBundledPlugins(options: {
  readonly appDir: string
  readonly resourcesPath?: string
  readonly expectedVersion?: string
}): Promise<ResolvedBundledPlugins | null> {
  const candidates: string[] = []
  if (options.resourcesPath !== undefined && options.resourcesPath.trim().length > 0) {
    candidates.push(path.join(options.resourcesPath, 'bundled-plugins'))
  }
  candidates.push(path.resolve(options.appDir, '..', 'desktop-bundled-plugins'))

  for (const candidate of candidates) {
    const resolved = await tryLoadBundledRoot(candidate, options.expectedVersion)
    if (resolved !== null) {
      return resolved
    }
  }
  return null
}
