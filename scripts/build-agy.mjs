/**
 * Build the self-contained Antigravity (AGY) plugin directory under `dist/agy-plugin/`.
 *
 * Bundles `src/agy/mcp-server.ts` and `src/agy/hook-cli.ts` as single-file ESM
 * executables via esbuild (no external `node_modules` needed at runtime), syncs
 * `version` from `package.json` into `plugin.json`, copies the SVG logo,
 * `mcp_config.json`, `hooks.json`, `rules/`, and `skills/`.
 *
 * Usage: `node scripts/build-agy.mjs`
 */
import { build } from 'esbuild'
import { access, copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutDir = resolve(root, 'dist/agy-plugin')
const assetsDir = resolve(root, 'src/agy/assets')

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
 * Bundle one TypeScript CLI entrypoint into a standalone Node 24 ESM script.
 * @param {string} entryRelative - Repo-relative `.ts` entry path.
 * @param {string} outfile - Absolute `.mjs` output path.
 */
async function bundleEntry(entryRelative, outfile) {
  const entry = resolve(root, entryRelative)
  try {
    await access(entry)
  } catch {
    throw new Error(`Missing AGY entrypoint: ${entryRelative}`)
  }
  await mkdir(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    logLevel: 'warning',
  })
}

/**
 * Build the self-contained AGY plugin under `dist/agy-plugin/` (or a custom `outDir`).
 * @param {{ outDir?: string }} [options] - Optional build destination override.
 * @returns {Promise<{ outDir: string; files: string[] }>} Output directory and sorted relative files.
 */
export async function buildAgyPlugin(options = {}) {
  const outDir = options.outDir ? resolve(root, options.outDir) : defaultOutDir

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  await bundleEntry('src/agy/mcp-server.ts', resolve(outDir, 'bin/mcp-server.mjs'))
  await bundleEntry('src/agy/hook-cli.ts', resolve(outDir, 'bin/hook.mjs'))

  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const pluginTemplate = JSON.parse(await readFile(resolve(assetsDir, 'plugin.json'), 'utf8'))
  pluginTemplate.version = pkg.version
  await writeFile(
    resolve(outDir, 'plugin.json'),
    `${JSON.stringify(pluginTemplate, null, 2)}\n`,
    'utf8',
  )

  await mkdir(resolve(outDir, 'assets'), { recursive: true })
  await copyFile(resolve(root, 'icon.svg'), resolve(outDir, 'assets/logo.svg'))
  await copyFile(resolve(assetsDir, 'mcp_config.json'), resolve(outDir, 'mcp_config.json'))
  await copyFile(resolve(assetsDir, 'hooks.json'), resolve(outDir, 'hooks.json'))
  await cp(resolve(assetsDir, 'rules'), resolve(outDir, 'rules'), { recursive: true })
  await cp(resolve(assetsDir, 'skills'), resolve(outDir, 'skills'), { recursive: true })

  const files = await collectFiles(outDir)
  return { outDir, files }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await buildAgyPlugin()
  console.log(`built dist/agy-plugin (${result.files.length} files)`)
}
