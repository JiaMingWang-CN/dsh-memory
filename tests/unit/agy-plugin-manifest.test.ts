import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgyPlugin } from '../../scripts/build-agy.mjs'
import { validateAgyPluginDir } from '../../scripts/pack-agy-check.mjs'
import { validateManifest } from '../../scripts/pack-check.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const ALLOWED_PLUGIN_KEYS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'logo',
  'suggestedPrompts',
  'author',
  'homepage',
  'repository',
  'disabled',
])

describe('AGY plugin manifest and isolation', () => {
  let tempRoot = ''
  let builtDir = ''
  let builtFiles: string[] = []

  function readOut(relative: string): string {
    return readFileSync(join(builtDir, ...relative.split('/')), 'utf8')
  }

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-agy-manifest-'))
    const outDir = join(tempRoot, 'agy-plugin')
    const result = await buildAgyPlugin({ outDir })
    builtDir = result.outDir
    builtFiles = result.files
  }, 30_000)

  afterAll(() => {
    if (tempRoot.length > 0) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('builds self-contained AGY plugin directory and passes validateAgyPluginDir with zero issues', () => {
    expect(builtDir).toBe(join(tempRoot, 'agy-plugin'))
    expect(builtFiles).toEqual(
      expect.arrayContaining([
        'plugin.json',
        'mcp_config.json',
        'hooks.json',
        'assets/logo.svg',
        'bin/mcp-server.mjs',
        'bin/hook.mjs',
        'rules/AGENTS.md',
        'skills/memory/SKILL.md',
        'skills/memory-dream/SKILL.md',
        'skills/memory-review/SKILL.md',
      ]),
    )
    expect(validateAgyPluginDir(builtDir)).toEqual([])
  })

  it('emits valid plugin.json within AGY allowlist and synced version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    const plugin = JSON.parse(readOut('plugin.json')) as Record<string, unknown>

    for (const key of Object.keys(plugin)) {
      expect(ALLOWED_PLUGIN_KEYS.has(key), `unexpected plugin.json key: ${key}`).toBe(true)
    }
    expect(plugin.name).toBe('dsh-memory')
    expect(plugin.displayName).toBe('DSH Memory')
    expect(plugin.version).toBe(pkg.version)
    expect(plugin.logo).toBe('assets/logo.svg')
    expect(Array.isArray(plugin.suggestedPrompts)).toBe(true)
    expect((plugin.suggestedPrompts as unknown[]).length).toBe(3)
  })

  it('emits frontmatter-free rules/AGENTS.md and valid frontmatter in all 3 skills', () => {
    const rules = readOut('rules/AGENTS.md')
    expect(rules.trimStart().startsWith('---')).toBe(false)

    for (const skill of ['memory', 'memory-dream', 'memory-review']) {
      const content = readOut(`skills/${skill}/SKILL.md`)
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      expect(match, `skills/${skill}/SKILL.md missing frontmatter`).not.toBeNull()
      expect(match?.[1]).toMatch(new RegExp(`^name:\\s*${skill}\\s*$`, 'm'))
      expect(match?.[1]).toMatch(/^description:\s*\S+/m)
    }
  })

  it('bundles bin/mcp-server.mjs and bin/hook.mjs with zero non-node static imports', () => {
    for (const binFile of ['bin/mcp-server.mjs', 'bin/hook.mjs']) {
      const code = readOut(binFile)
      const importMatches = [
        ...code.matchAll(/^(?:import|export)\s+(?:[^'"\n;]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
      ]
      for (const match of importMatches) {
        expect(match[1]?.startsWith('node:'), `${binFile} external import: ${match[1]}`).toBe(true)
      }
    }
  })

  it('rejects AGY build outputs in DSH pack-check validateManifest', () => {
    const baseFiles = [
      'package.json',
      'cordis.patch.yml',
      'dist/client.js',
      'dist/host/index.js',
      'locale/zh.json',
      'locale/en.json',
      'icon.svg',
      'docs/DETAIL.md',
    ]
    const problems = validateManifest({
      files: [
        ...baseFiles.map((path) => ({ path })),
        { path: 'dist/agy/mcp-server.js' },
        { path: 'dist/agy-plugin/plugin.json' },
      ],
    })
    expect(problems).toContain('forbidden file: dist/agy/mcp-server.js')
    expect(problems).toContain('forbidden file: dist/agy-plugin/plugin.json')
  })
})
