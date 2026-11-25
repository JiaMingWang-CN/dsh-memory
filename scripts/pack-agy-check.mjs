/**
 * Validate the built self-contained Antigravity (AGY) plugin directory.
 *
 * Checks required files, `plugin.json` top-level allowlist and metadata,
 * `mcp_config.json` and `hooks.json` structure + referenced scripts,
 * `rules/AGENTS.md` frontmatter absence, `skills/<name>/SKILL.md` frontmatter,
 * absence of sourcemaps/tests/private files, and verifies `bin/*.mjs` bundles
 * have no non-`node:` static external imports.
 *
 * Usage: `node scripts/pack-agy-check.mjs`
 */
import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutDir = resolve(root, 'dist/agy-plugin')

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

const REQUIRED_FILES = [
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
]

const REQUIRED_SKILLS = ['memory', 'memory-dream', 'memory-review']

const FORBIDDEN_PATTERNS = [
  /\.map$/,
  /\.tgz$/,
  /\.tsbuildinfo$/,
  /(^|\/)node_modules\//,
  /(^|\/)src\//,
  /(^|\/)tests\//,
  /(^|\/)\.codegraph\//,
  /(^|\/)\.agents\//,
  /(^|\/)\.git\//,
  /^AGENTS\.md$/,
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
  return out
}

/**
 * Parse a JSON file safely, returning `{ data }` or `{ error }`.
 * @param {string} filePath - Absolute JSON file path.
 * @returns {{ data?: unknown; error?: string }}
 */
function readJsonSafe(filePath) {
  try {
    return { data: JSON.parse(readFileSync(filePath, 'utf8')) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: message }
  }
}

/**
 * Extract top-level static ES module specifiers from a JavaScript bundle.
 * @param {string} code - JavaScript source text.
 * @returns {string[]} Module specifiers in import/export statements.
 */
function extractStaticImports(code) {
  const sourceFile = ts.createSourceFile(
    'bundle.mjs',
    code,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.JS,
  )
  const specifiers = []
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text)
    }
  }
  return specifiers
}

/**
 * Resolve the script path inside a hook command like `node ./bin/hook.mjs`.
 * @param {string} command - Hook command string.
 * @returns {string | undefined} Relative script path when detectable.
 */
function extractCommandScript(command) {
  const trimmed = command.trim()
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
  if (tokens === null || tokens.length === 0) return undefined
  const unquote = (token) => token.replace(/^['"]|['"]$/g, '')
  const first = unquote(tokens[0])
  if (first === 'node' || first === 'node.exe') {
    const candidate = tokens.slice(1).find((token) => !unquote(token).startsWith('-'))
    return candidate ? unquote(candidate) : undefined
  }
  return first
}

/**
 * Parse YAML frontmatter fields `name` and `description` from a `SKILL.md` file.
 * @param {string} content - Markdown content.
 * @returns {{ hasFrontmatter: boolean; name?: string; description?: string }}
 */
function parseSkillFrontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (match === null) return { hasFrontmatter: false }

  const lines = match[1].split(/\r?\n/)
  const fields = {}
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (keyMatch === null) continue
    const key = keyMatch[1]
    const rawValue = keyMatch[2].trim()
    if (rawValue === '>' || rawValue === '>-' || rawValue === '|' || rawValue === '|-') {
      const blockLines = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i += 1
        blockLines.push(lines[i].trim())
      }
      fields[key] = blockLines.filter(Boolean).join(' ').trim()
    } else {
      fields[key] = rawValue.replace(/^['"]|['"]$/g, '').trim()
    }
  }
  return {
    hasFrontmatter: true,
    name: fields.name,
    description: fields.description,
  }
}

/**
 * Validate `plugin.json` manifest structure and allowlist.
 * @param {string} outDir - Built plugin directory.
 * @param {string[]} problems - Mutable problems list.
 */
function validatePluginManifest(outDir, problems) {
  const pluginPath = resolve(outDir, 'plugin.json')
  if (!existsSync(pluginPath)) return
  const parsed = readJsonSafe(pluginPath)
  if (parsed.error !== undefined) {
    problems.push(`invalid plugin.json: ${parsed.error}`)
    return
  }
  const plugin = parsed.data
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) {
    problems.push('plugin.json must be a JSON object')
    return
  }
  for (const key of Object.keys(plugin)) {
    if (!ALLOWED_PLUGIN_KEYS.has(key)) {
      problems.push(`unknown plugin.json top-level key: ${key}`)
    }
  }
  if (plugin.name !== 'dsh-memory') {
    problems.push(`plugin.json name must be "dsh-memory" (got ${JSON.stringify(plugin.name)})`)
  }
  if (typeof plugin.displayName !== 'string' || plugin.displayName.trim() === '') {
    problems.push('plugin.json displayName must be a non-empty string')
  }
  if (typeof plugin.version !== 'string' || !/^\d+\.\d+\.\d+/.test(plugin.version)) {
    problems.push(
      `plugin.json version must be a semver string (got ${JSON.stringify(plugin.version)})`,
    )
  }
  if (typeof plugin.description !== 'string' || plugin.description.trim() === '') {
    problems.push('plugin.json description must be a non-empty string')
  }
  if (plugin.logo !== 'assets/logo.svg') {
    problems.push(`plugin.json logo must be "assets/logo.svg" (got ${JSON.stringify(plugin.logo)})`)
  } else if (!existsSync(resolve(outDir, plugin.logo))) {
    problems.push(`plugin.json referenced logo missing: ${plugin.logo}`)
  }
  if (
    !Array.isArray(plugin.suggestedPrompts) ||
    plugin.suggestedPrompts.length !== 3 ||
    plugin.suggestedPrompts.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    problems.push('plugin.json suggestedPrompts must contain exactly 3 non-empty strings')
  }
}

/**
 * Validate `mcp_config.json` structure.
 * @param {string} outDir - Built plugin directory.
 * @param {string[]} problems - Mutable problems list.
 */
function validateMcpConfig(outDir, problems) {
  const mcpPath = resolve(outDir, 'mcp_config.json')
  if (!existsSync(mcpPath)) return
  const parsed = readJsonSafe(mcpPath)
  if (parsed.error !== undefined) {
    problems.push(`invalid mcp_config.json: ${parsed.error}`)
    return
  }
  const config = parsed.data
  const memory = config?.mcpServers?.memory
  if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
    problems.push('mcp_config.json must define mcpServers.memory')
    return
  }
  if (memory.command !== 'node') {
    problems.push(`mcp_config.json mcpServers.memory.command must be "node"`)
  }
  if (!Array.isArray(memory.args) || !memory.args.includes('${PLUGIN_ROOT}/bin/mcp-server.mjs')) {
    problems.push(
      'mcp_config.json mcpServers.memory.args must include "${PLUGIN_ROOT}/bin/mcp-server.mjs"',
    )
  }
  if (
    memory.env === null ||
    typeof memory.env !== 'object' ||
    memory.env.PLUGIN_DATA !== '${PLUGIN_DATA}' ||
    memory.env.PLUGIN_ROOT !== '${PLUGIN_ROOT}'
  ) {
    problems.push('mcp_config.json mcpServers.memory.env must pass PLUGIN_DATA and PLUGIN_ROOT')
  }
}

/**
 * Validate a flat or matcher-grouped hook handler list.
 * @param {unknown} entries - Hook event array.
 * @param {string} label - Diagnostic label.
 * @param {boolean} grouped - Whether entries are `{ matcher, hooks }`.
 * @param {string} outDir - Built plugin directory.
 * @param {string[]} problems - Mutable problems list.
 */
function validateHookEntries(entries, label, grouped, outDir, problems) {
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push(`hooks.json ${label} must be a non-empty array`)
    return
  }
  const checkHandler = (handler, handlerLabel) => {
    if (handler === null || typeof handler !== 'object' || Array.isArray(handler)) {
      problems.push(`hooks.json ${handlerLabel} must be an object`)
      return
    }
    if (handler.type !== undefined && handler.type !== 'command') {
      problems.push(`hooks.json ${handlerLabel}.type must be "command"`)
    }
    if (typeof handler.command !== 'string' || handler.command.trim() === '') {
      problems.push(`hooks.json ${handlerLabel}.command must be a non-empty string`)
      return
    }
    const scriptRel = extractCommandScript(handler.command)
    if (scriptRel === undefined) {
      problems.push(`hooks.json ${handlerLabel}.command has no target script: ${handler.command}`)
      return
    }
    const scriptAbs = resolve(outDir, scriptRel)
    const relToOut = relative(outDir, scriptAbs)
    if (relToOut.startsWith('..') || !existsSync(scriptAbs)) {
      problems.push(`hooks.json ${handlerLabel} references missing script: ${scriptRel}`)
    }
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!grouped) {
      checkHandler(entry, `${label}[${i}]`)
      continue
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`hooks.json ${label}[${i}] must be an object`)
      continue
    }
    if (typeof entry.matcher !== 'string' || entry.matcher.trim() === '') {
      problems.push(`hooks.json ${label}[${i}].matcher must be a non-empty string`)
    }
    if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) {
      problems.push(`hooks.json ${label}[${i}].hooks must be a non-empty array`)
      continue
    }
    for (let j = 0; j < entry.hooks.length; j += 1) {
      checkHandler(entry.hooks[j], `${label}[${i}].hooks[${j}]`)
    }
  }
}

/**
 * Validate `hooks.json` schema and script paths.
 * @param {string} outDir - Built plugin directory.
 * @param {string[]} problems - Mutable problems list.
 */
function validateHooksConfig(outDir, problems) {
  const hooksPath = resolve(outDir, 'hooks.json')
  if (!existsSync(hooksPath)) return
  const parsed = readJsonSafe(hooksPath)
  if (parsed.error !== undefined) {
    problems.push(`invalid hooks.json: ${parsed.error}`)
    return
  }
  const rootObj = parsed.data
  if (rootObj === null || typeof rootObj !== 'object' || Array.isArray(rootObj)) {
    problems.push('hooks.json must be a JSON object')
    return
  }
  const spec = rootObj['dsh-memory']
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    problems.push('hooks.json must define top-level hook entry "dsh-memory"')
    return
  }
  validateHookEntries(spec.PreInvocation, 'dsh-memory.PreInvocation', false, outDir, problems)
  validateHookEntries(spec.Stop, 'dsh-memory.Stop', false, outDir, problems)
  validateHookEntries(spec.PreToolUse, 'dsh-memory.PreToolUse', true, outDir, problems)
}

/**
 * Validate the built AGY plugin directory and return any problems found.
 * @param {string} [outDir] - Directory to validate; defaults to `dist/agy-plugin`.
 * @returns {string[]} Human-readable validation issues; empty means valid.
 */
export function validateAgyPluginDir(outDir = defaultOutDir) {
  const resolvedOutDir = resolve(root, outDir)
  const problems = []

  if (!existsSync(resolvedOutDir) || !statSync(resolvedOutDir).isDirectory()) {
    return [`missing AGY plugin directory: ${resolvedOutDir}`]
  }

  const actualFiles = new Set(listFiles(resolvedOutDir))
  for (const required of REQUIRED_FILES) {
    if (!actualFiles.has(required)) {
      problems.push(`missing required file: ${required}`)
    } else if (statSync(resolve(resolvedOutDir, required)).size === 0) {
      problems.push(`empty required file: ${required}`)
    }
  }

  for (const file of actualFiles) {
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))) {
      problems.push(`forbidden artifact in AGY plugin: ${file}`)
    }
  }

  validatePluginManifest(resolvedOutDir, problems)
  validateMcpConfig(resolvedOutDir, problems)
  validateHooksConfig(resolvedOutDir, problems)

  const logoPath = resolve(resolvedOutDir, 'assets/logo.svg')
  if (existsSync(logoPath)) {
    const logoText = readFileSync(logoPath, 'utf8')
    if (!logoText.trimStart().startsWith('<svg')) {
      problems.push('assets/logo.svg must be an SVG image')
    }
  }

  const rulesPath = resolve(resolvedOutDir, 'rules/AGENTS.md')
  if (existsSync(rulesPath)) {
    const rulesText = readFileSync(rulesPath, 'utf8').replace(/^\uFEFF/, '')
    if (rulesText.trimStart().startsWith('---')) {
      problems.push('rules/AGENTS.md must not contain YAML frontmatter')
    }
    if (Buffer.byteLength(rulesText, 'utf8') > 24_000) {
      problems.push('rules/AGENTS.md exceeds 24,000-byte AGY rule cap')
    }
  }

  for (const skillName of REQUIRED_SKILLS) {
    const skillPath = resolve(resolvedOutDir, `skills/${skillName}/SKILL.md`)
    if (!existsSync(skillPath)) continue
    const parsedSkill = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
    if (!parsedSkill.hasFrontmatter) {
      problems.push(`skills/${skillName}/SKILL.md is missing YAML frontmatter`)
    } else {
      if (parsedSkill.name !== skillName) {
        problems.push(
          `skills/${skillName}/SKILL.md frontmatter name must be "${skillName}" (got ${JSON.stringify(parsedSkill.name)})`,
        )
      }
      if (!parsedSkill.description) {
        problems.push(`skills/${skillName}/SKILL.md frontmatter description must be non-empty`)
      }
    }
  }

  for (const binRel of ['bin/mcp-server.mjs', 'bin/hook.mjs']) {
    const binPath = resolve(resolvedOutDir, binRel)
    if (!existsSync(binPath)) continue
    const code = readFileSync(binPath, 'utf8')
    if (/\/\/# sourceMappingURL=/.test(code)) {
      problems.push(`${binRel} must not reference a sourcemap`)
    }
    for (const specifier of extractStaticImports(code)) {
      if (!specifier.startsWith('node:')) {
        problems.push(`${binRel} contains non-node static import: ${specifier}`)
      }
    }
  }

  return problems
}

/**
 * Run the AGY plugin check and print a summary.
 * @returns {number} Process exit code.
 */
export function run() {
  const problems = validateAgyPluginDir()
  if (problems.length > 0) {
    console.error(`pack-agy-check failed (${problems.length} issue(s)):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('pack-agy-check passed: dist/agy-plugin is valid.')
  return 0
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = run()
}
