/**
 * Build the Client half as one browser module for DSH's module loader.
 *
 * esbuild bundles `src/client/index.ts` as CommonJS with React kept external,
 * then this script wraps the result in `window.__ModuleLoader__.load({...})`.
 * The loader passes `require`, so `require('react')` resolves against the
 * browser module table and no second React copy is shipped.
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Package identity the browser module table keys this bundle by. */
const packageName = async () =>
  JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).name

/**
 * Bundle the Client half and write `dist/client.js`.
 * @returns The absolute output path and the wrapped source text.
 */
export async function buildClient() {
  const entry = resolve(root, 'src/client/index.ts')
  const outfile = resolve(root, 'dist/client.js')

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    external: ['react'],
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    logLevel: 'warning',
  })

  const output = result.outputFiles?.[0]
  if (output === undefined) {
    throw new Error('esbuild produced no output for the Client bundle')
  }

  const indent = (text) =>
    text
      .split('\n')
      .map((line) => (line.length === 0 ? line : `    ${line}`))
      .join('\n')

  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(await packageName())},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
${indent(output.text)}
    return module.exports;
  },
});
`

  await mkdir(dirname(outfile), { recursive: true })
  await writeFile(outfile, wrapped, 'utf8')
  return { outfile, text: wrapped }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildClient()
  console.log('built dist/client.js')
}
