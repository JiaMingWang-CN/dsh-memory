/**
 * Validate the built Electron desktop app directory under `dist/desktop-app/`.
 *
 * Checks required files, `package.json` metadata (`name`, `version`, `main`,
 * `private`), absence of sourcemaps/tests/node_modules/private docs, and
 * verifies `main.cjs` and `preload.cjs` contain zero `@deepseek-ai/` imports.
 *
 * Usage: `node scripts/pack-desktop-check.mjs`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutDir = resolve(root, 'dist/desktop-app')

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
 * Run the desktop artifact check and print a summary.
 * @returns {number} Process exit code.
 */
export function runDesktopPackCheck() {
  const problems = validateDesktopArtifact()
  if (problems.length > 0) {
    console.error(`pack-desktop-check failed (${problems.length} problems):`)
    for (const problem of problems) {
      console.error(`  - ${problem}`)
    }
    return 1
  }
  const files = listFiles(defaultOutDir)
  console.log(`pack-desktop-check passed: ${files.length} files verified in dist/desktop-app.`)
  return 0
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = runDesktopPackCheck()
}
