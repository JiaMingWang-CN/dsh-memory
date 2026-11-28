/**
 * Validate the built Electron desktop app directory under `dist/desktop-app/`.
 *
 * Checks required files, `package.json` metadata (`name`, `version`, `main`,
 * `private`), absence of sourcemaps/tests/node_modules/private docs, and
 * verifies `main.cjs` and `preload.cjs` contain zero `@deepseek-ai/` imports.
 *
 * Usage: `node scripts/pack-desktop-check.mjs`
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutDir = resolve(root, 'dist/desktop-app')
const defaultBundledOutDir = resolve(root, 'dist/desktop-bundled-plugins')
const SHA256_RE = /^[a-f0-9]{64}$/i
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/

const REQUIRED_FILES = [
  'package.json',
  'main.cjs',
  'preload.cjs',
  'local-launcher.mjs',
  'renderer/index.html',
  'renderer/index.js',
  'renderer/local-bridge.js',
  'renderer/theme.css',
  'assets/icon.ico',
]

const FORBIDDEN_PATTERNS = [
  /\.map$/,
  /\.tgz$/,
  /\.tsbuildinfo$/,
  /(^|\/)src\//,
  /(^|\/)tests\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.codegraph\//,
  /(^|\/)\.agents\//,
  /(^|\/)\.git\//,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /(^|\/)docs\/(specs|plans)\//,
  /(^|\/)release-checklist\.md$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
]

/**
 * Walk a directory recursively and return POSIX-relative file paths.
 * @param {string} baseDir - Root directory.
 * @param {string} [currentDir] - Current directory.
 * @returns {string[]} Relative file paths.
 */
function listFiles(baseDir, currentDir = baseDir) {
  const out = []
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const full = resolve(currentDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFiles(baseDir, full))
    } else if (entry.isFile()) {
      out.push(relative(baseDir, full).split('\\').join('/'))
    }
  }
  return out.sort()
}

/**
 * Validate a built desktop app directory and return human-readable problems.
 * @param {string} [outDir] - Target desktop build directory.
 * @returns {string[]} Problems list; empty means valid.
 */
export function validateDesktopArtifact(outDir = defaultOutDir) {
  const resolvedOutDir = resolve(root, outDir)
  if (!existsSync(resolvedOutDir) || !statSync(resolvedOutDir).isDirectory()) {
    return [`missing desktop build directory: ${resolvedOutDir}`]
  }

  const problems = []
  const files = listFiles(resolvedOutDir)
  const fileSet = new Set(files)

  for (const file of files) {
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))) {
      problems.push(`forbidden desktop artifact file: ${file}`)
    }
  }

  for (const required of REQUIRED_FILES) {
    if (!fileSet.has(required)) {
      problems.push(`missing required desktop file: ${required}`)
    }
  }

  const pkgPath = resolve(resolvedOutDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
        problems.push('desktop package.json must be a JSON object')
      } else {
        if (pkg.name !== 'memloom-desktop') {
          problems.push(
            `desktop package.json name must be "memloom-desktop", got ${String(pkg.name)}`,
          )
        }
        if (pkg.main !== './main.cjs') {
          problems.push(`desktop package.json main must be "./main.cjs", got ${String(pkg.main)}`)
        }
        if (pkg.private !== true) {
          problems.push('desktop package.json must set private: true')
        }
        if (typeof pkg.version !== 'string' || pkg.version.trim().length === 0) {
          problems.push('desktop package.json must define a non-empty version')
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`invalid desktop package.json: ${message}`)
    }
  }

  for (const bundleFile of ['main.cjs', 'preload.cjs', 'local-launcher.mjs']) {
    const bundlePath = resolve(resolvedOutDir, bundleFile)
    if (!existsSync(bundlePath)) continue
    const code = readFileSync(bundlePath, 'utf8')
    if (code.trim().length === 0) {
      problems.push(`${bundleFile} is empty`)
    }
    if (/@deepseek-ai\//.test(code)) {
      problems.push(`${bundleFile} must not reference @deepseek-ai/*`)
    }
  }

  const icoPath = resolve(resolvedOutDir, 'assets/icon.ico')
  if (existsSync(icoPath)) {
    const ico = readFileSync(icoPath)
    if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
      problems.push('assets/icon.ico must have a valid ICO header')
    }
  }

  return problems
}

/**
 * Check that a relative path inside a manifest cannot traverse outside its root.
 * @param {string} rawPath
 * @returns {boolean}
 */
function isSafeManifestRelPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    return false
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\') || WINDOWS_DRIVE_RE.test(rawPath)) {
    return false
  }
  const segments = rawPath.replace(/\\/g, '/').split('/')
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'),
  )
}

/**
 * Validate a built desktop bundled-plugins directory and return human-readable problems.
 * @param {string} [outDir] - Target bundled plugins directory.
 * @param {string} [expectedVersion] - Optional expected version matching root `package.json`.
 * @returns {string[]} Problems list; empty means valid.
 */
export function validateBundledPluginsArtifact(outDir = defaultBundledOutDir, expectedVersion) {
  const resolvedOutDir = resolve(root, outDir)
  if (!existsSync(resolvedOutDir) || !statSync(resolvedOutDir).isDirectory()) {
    return [`missing bundled plugins directory: ${resolvedOutDir}`]
  }

  const problems = []
  const manifestPath = resolve(resolvedOutDir, 'manifest.json')
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    return [`missing bundled plugins manifest: ${manifestPath}`]
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [`invalid bundled plugins manifest.json: ${message}`]
  }

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['bundled plugins manifest.json must be a JSON object']
  }

  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    problems.push('bundled plugins manifest.version must be a non-empty string')
  } else if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    problems.push(
      `bundled plugins version mismatch: expected ${expectedVersion}, got ${manifest.version}`,
    )
  }

  if (typeof manifest.builtAt !== 'string' || manifest.builtAt.trim().length === 0) {
    problems.push('bundled plugins manifest.builtAt must be a non-empty string')
  }

  // Validate AGY section
  const agy = manifest.agy
  if (agy === null || typeof agy !== 'object' || Array.isArray(agy)) {
    problems.push('bundled plugins manifest.agy must be an object')
  } else {
    if (!isSafeManifestRelPath(agy.dir)) {
      problems.push(`unsafe bundled plugins agy.dir: ${String(agy.dir)}`)
    }
    if (!Array.isArray(agy.files) || agy.files.length === 0) {
      problems.push('bundled plugins manifest.agy.files must be a non-empty array')
    }
    if (typeof agy.sha256 !== 'string' || !SHA256_RE.test(agy.sha256)) {
      problems.push('bundled plugins manifest.agy.sha256 must be a 64-char hex digest')
    }

    if (
      isSafeManifestRelPath(agy.dir) &&
      Array.isArray(agy.files) &&
      agy.files.length > 0 &&
      typeof agy.sha256 === 'string' &&
      SHA256_RE.test(agy.sha256)
    ) {
      const agyDir = resolve(resolvedOutDir, ...agy.dir.replace(/\\/g, '/').split('/'))
      const relAgyDir = relative(resolvedOutDir, agyDir)
      if (relAgyDir.startsWith('..') || isAbsolute(relAgyDir)) {
        problems.push(`bundled plugins agy.dir escapes root: ${agy.dir}`)
      } else if (!existsSync(agyDir) || !statSync(agyDir).isDirectory()) {
        problems.push(`missing bundled AGY plugin directory: ${agy.dir}`)
      } else {
        const sortedFiles = [...agy.files].sort()
        const hash = createHash('sha256')
        let allFilesValid = true
        for (const rel of sortedFiles) {
          if (!isSafeManifestRelPath(rel)) {
            problems.push(`unsafe bundled AGY file path: ${String(rel)}`)
            allFilesValid = false
            continue
          }
          const full = resolve(agyDir, ...rel.replace(/\\/g, '/').split('/'))
          const relCheck = relative(agyDir, full)
          if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
            problems.push(`bundled AGY file escapes agy.dir: ${rel}`)
            allFilesValid = false
            continue
          }
          if (!existsSync(full) || !statSync(full).isFile()) {
            problems.push(`missing bundled AGY file: ${rel}`)
            allFilesValid = false
            continue
          }
          hash.update(`${rel.replace(/\\/g, '/')}\0`).update(readFileSync(full))
        }
        if (allFilesValid) {
          const actualSha = hash.digest('hex')
          if (actualSha.toLowerCase() !== agy.sha256.toLowerCase()) {
            problems.push(`bundled AGY sha256 mismatch: expected ${agy.sha256}, got ${actualSha}`)
          }
        }
        const pluginJsonPath = resolve(agyDir, 'plugin.json')
        if (!sortedFiles.includes('plugin.json') || !existsSync(pluginJsonPath)) {
          problems.push('bundled AGY plugin is missing plugin.json')
        } else {
          try {
            const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'))
            if (pluginJson.name !== 'memloom') {
              problems.push(
                `bundled AGY plugin.json name must be "memloom", got ${String(pluginJson.name)}`,
              )
            }
            if (typeof manifest.version === 'string' && pluginJson.version !== manifest.version) {
              problems.push(
                `bundled AGY plugin.json version mismatch: expected ${manifest.version}, got ${String(pluginJson.version)}`,
              )
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            problems.push(`invalid bundled AGY plugin.json: ${message}`)
          }
        }
      }
    }
  }

  // Validate DSH section
  const dsh = manifest.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) {
    problems.push('bundled plugins manifest.dsh must be an object')
  } else {
    if (!isSafeManifestRelPath(dsh.file) || !String(dsh.file).endsWith('.tgz')) {
      problems.push(`unsafe or invalid bundled DSH tarball path: ${String(dsh.file)}`)
    }
    if (typeof dsh.sha256 !== 'string' || !SHA256_RE.test(dsh.sha256)) {
      problems.push('bundled plugins manifest.dsh.sha256 must be a 64-char hex digest')
    }
    if (
      isSafeManifestRelPath(dsh.file) &&
      typeof dsh.sha256 === 'string' &&
      SHA256_RE.test(dsh.sha256)
    ) {
      const tgzPath = resolve(resolvedOutDir, ...dsh.file.replace(/\\/g, '/').split('/'))
      const relTgz = relative(resolvedOutDir, tgzPath)
      if (relTgz.startsWith('..') || isAbsolute(relTgz)) {
        problems.push(`bundled DSH tarball escapes root: ${dsh.file}`)
      } else if (!existsSync(tgzPath) || !statSync(tgzPath).isFile()) {
        problems.push(`missing bundled DSH tarball: ${dsh.file}`)
      } else {
        const actualSha = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
        if (actualSha.toLowerCase() !== dsh.sha256.toLowerCase()) {
          problems.push(`bundled DSH sha256 mismatch: expected ${dsh.sha256}, got ${actualSha}`)
        }
      }
    }
  }

  return problems
}

/**
 * Run the desktop artifact check and print a summary.
 * @param {{ requireBundled?: boolean }} [options]
 * @returns {number} Process exit code.
 */
export function runDesktopPackCheck(options = {}) {
  const problems = validateDesktopArtifact()
  const shouldCheckBundled = options.requireBundled === true || existsSync(defaultBundledOutDir)
  if (shouldCheckBundled) {
    const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    problems.push(...validateBundledPluginsArtifact(defaultBundledOutDir, String(rootPkg.version)))
  }

  if (problems.length > 0) {
    console.error(`pack-desktop-check failed (${problems.length} problems):`)
    for (const problem of problems) {
      console.error(`  - ${problem}`)
    }
    return 1
  }
  const files = listFiles(defaultOutDir)
  const suffix = shouldCheckBundled ? ' + dist/desktop-bundled-plugins' : ''
  console.log(
    `pack-desktop-check passed: ${files.length} files verified in dist/desktop-app${suffix}.`,
  )
  return 0
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const requireBundled = process.argv.includes('--require-bundled')
  process.exitCode = runDesktopPackCheck({ requireBundled })
}
