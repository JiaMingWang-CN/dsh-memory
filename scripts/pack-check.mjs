/**
 * Validate the publishable bundle file list before release.
 *
 * Runs `pnpm pack --dry-run --json` and rejects any file outside the intended
 * package surface: built JavaScript and type declarations, the loader patch,
 * locale JSON, user docs and the icon. Tests, `src`, source maps, local tool
 * directories and node_modules must never ship.
 *
 * Usage: `node scripts/pack-check.mjs`
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Files npm/pnpm always add regardless of the `files` allowlist. */
const ALWAYS_INCLUDED = new Set(['package.json', 'README.md', 'README.en.md', 'LICENSE'])

/** Files or suffixes that must never be packaged. */
const FORBIDDEN = [
  /(^|\/)src\//,
  /(^|\/)tests\//,
  /(^|\/)\.codegraph\//,
  /(^|\/)\.agents\//,
  /(^|\/)node_modules\//,
  /(^|\/)desktop\//,
  /(^|\/)dist\/agy(-plugin)?\//,
  /(^|\/)dist\/desktop(-app|-release)?\//,
  /\.map$/,
  /\.tgz$/,
  /\.tsbuildinfo$/,
]

/** Files the bundle must contain to be installable. */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'dist/client.js',
  'dist/host/index.js',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'docs/DETAIL.md',
]

/**
 * Whether one packed path is part of the allowed package surface.
 * @param {string} path - Pack-relative path.
 * @returns {boolean} True when allowed.
 */
function isAllowed(path) {
  if (ALWAYS_INCLUDED.has(path)) return true
  if (path === 'cordis.patch.yml' || path === 'icon.svg') return true
  if (path.startsWith('dist/')) return /\.(js|d\.ts)$/.test(path)
  if (path.startsWith('locale/')) return path.endsWith('.json')
  if (path.startsWith('docs/')) return path.endsWith('.md')
  return false
}

/**
 * Read the file list `pnpm pack` would produce.
 *
 * `--ignore-scripts` keeps the `prepack` build out of this dry run: its stdout
 * would otherwise precede the JSON manifest. Callers build first (CI runs
 * `pnpm build` before this check), and a missing `dist` is reported as a
 * missing required file.
 * @returns {{ name: string, version: string, files: { path: string }[] }}
 */
export function packedManifest() {
  // One constant command string (no caller input) avoids DEP0190, which warns
  // about an args array combined with `shell: true`. Windows needs the shell to
  // resolve `pnpm.cmd`.
  const command = `${process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'} pack --dry-run --json --ignore-scripts`
  const result = spawnSync(command, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
  })
  if (result.status !== 0) {
    throw new Error(`pnpm pack --dry-run failed: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

/**
 * Validate a packed manifest and return the human-readable problems found.
 * @param {{ files: { path: string }[] }} manifest - Parsed pack manifest.
 * @returns {string[]} Problems; empty means the bundle is valid.
 */
export function validateManifest(manifest) {
  const problems = []
  const paths = new Set(manifest.files.map((file) => file.path))
  for (const path of paths) {
    if (FORBIDDEN.some((pattern) => pattern.test(path))) {
      problems.push(`forbidden file: ${path}`)
    } else if (!isAllowed(path)) {
      problems.push(`file outside the allowlist: ${path}`)
    }
  }
  for (const required of REQUIRED) {
    if (!paths.has(required)) problems.push(`missing required file: ${required}`)
  }
  return problems
}

/**
 * Run the check and print a summary; sets a non-zero exit code on failure.
 * @returns {number} Process exit code.
 */
export function run() {
  const manifest = packedManifest()
  const problems = validateManifest(manifest)
  const count = manifest.files.length
  if (problems.length > 0) {
    console.error(`pack-check failed for ${manifest.name}@${manifest.version} (${count} files):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log(`pack-check passed: ${manifest.name}@${manifest.version}, ${count} files.`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run()
}
