import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMemoryConfig, type MemoryConfig } from '../../src/host/config.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function pathOf(relative: string): string {
  return join(repoRoot, ...relative.split('/'))
}

function readText(relative: string): string {
  return readFileSync(pathOf(relative), 'utf8')
}

/** User-facing files that must ship with the repository. */
const REQUIRED_FILES = [
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'docs/architecture.md',
  'docs/agy.md',
  'docs/memory-model.md',
  'docs/dreaming.md',
  'docs/configuration.md',
  'docs/security.md',
  'docs/DETAIL.md',
  'examples/cordis.patch.yml',
]

const LOCAL_DESIGN_SPEC = 'docs/specs/2026-11-15-dsh-memory-design.md'

/** User-facing docs that must not overstate the 0.1.0 development status. */
const STATUS_SCAN = [
  'README.md',
  'README.en.md',
  'docs/DETAIL.md',
  'docs/architecture.md',
  'docs/agy.md',
  'docs/memory-model.md',
  'docs/dreaming.md',
  'docs/configuration.md',
  'docs/security.md',
]

const FORBIDDEN_CLAIMS = [
  '已稳定',
  '生产可用',
  '自动激活',
  '自动提升为全局',
  '转录自动读取',
  'transcript_read',
]

const INTERNAL_NAMES = [
  'MemoryDreamer',
  'DreamScheduler',
  'checkDreamHealth',
  'classifyDreamError',
  'detectStrongSecret',
  'normalizeEscapedNewlines',
  'dream-health.ts',
  'dream-prompt.ts',
]

/** First Markdown table row whose first column is the given backticked key. */
function rowOf(document: string, key: string): string | undefined {
  const pattern = new RegExp('^\\|\\s*`' + key + '`\\s*\\|')
  return document.split(/\r?\n/).find((line) => pattern.test(line))
}

/** Assert that a document contains each expression. */
function expectContains(relative: string, patterns: readonly RegExp[]): void {
  const text = readText(relative)
  for (const pattern of patterns) {
    expect(text, `${relative} must match ${String(pattern)}`).toMatch(pattern)
  }
}

describe('documentation consistency', () => {
  it('ships every documented file', () => {
    for (const relative of REQUIRED_FILES) {
      expect(existsSync(pathOf(relative)), relative).toBe(true)
    }
  })

  it('documents every live config default without inventing new fields', () => {
    const config = resolveMemoryConfig()
    const doc = readText('docs/configuration.md')

    expect(config.autoDream).toBe(false)
    expect(config.refreshIndexOnChange).toBe(false)
    expect(config.autoCaptureEpisodes).toBe(true)
    expect(config.indexMaxBytes).toBe(4096)

    const documentedKeys = new Set(
      [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1] as string),
    )
    const optionalKeys = ['dreamProvider', 'dreamModel', 'dreamReasoningEffort']
    const expectedKeys = [...Object.keys(config), ...optionalKeys]
    for (const key of expectedKeys) {
      expect(documentedKeys.has(key), `docs/configuration.md is missing ${key}`).toBe(true)
    }
    expect(documentedKeys.size, 'docs/configuration.md documents an unknown config field').toBe(
      expectedKeys.length,
    )

    for (const [key, value] of Object.entries(config)) {
      const row = rowOf(doc, key)
      expect(row, `docs/configuration.md is missing ${key}`).toBeDefined()
      expect(row, `docs/configuration.md has a stale default for ${key}`).toContain(
        '`' + String(value) + '`',
      )
    }
    for (const key of optionalKeys) {
      expect(rowOf(doc, key), `docs/configuration.md is missing ${key}`).toBeDefined()
      expect(rowOf(doc, key)).toContain('未设置')
    }
  })

  it('keeps README, README.en and dreaming defaults aligned with Config', () => {
    const config = resolveMemoryConfig()
    const flags: Array<[keyof MemoryConfig, string]> = [
      ['autoDream', String(config.autoDream)],
      ['refreshIndexOnChange', String(config.refreshIndexOnChange)],
      ['autoCaptureEpisodes', String(config.autoCaptureEpisodes)],
      ['indexMaxBytes', String(config.indexMaxBytes)],
      ['redactSecrets', String(config.redactSecrets)],
      ['injectForSubagents', String(config.injectForSubagents)],
    ]
    for (const relative of ['README.md', 'README.en.md']) {
      const doc = readText(relative)
      for (const [key, value] of flags) {
        const row = rowOf(doc, key)
        expect(row, `${relative} is missing ${key}`).toBeDefined()
        expect(row, `${relative} has a stale default for ${key}`).toContain('`' + value + '`')
      }
    }

    const dreaming = readText('docs/dreaming.md')
    const dreamingDefaults: Array<[string, RegExp]> = [
      ['dreamIdleDelayMs', /`dreamIdleDelayMs`[^\n]*30 秒/],
      ['autoDreamMinIntervalMs', /`autoDreamMinIntervalMs`[^\n]*5 分钟/],
      ['dreamLookbackDays', /`dreamLookbackDays`[^\n]*7 天/],
      ['dreamMaxSessionsPerRun', /`dreamMaxSessionsPerRun`[^\n]*10/],
      ['dreamMaxTokens', /`dreamMaxTokens`[^\n]*4096/],
      ['dreamMaxEpisodes', /`dreamMaxEpisodes`[^\n]*40/],
    ]
    for (const [key, pattern] of dreamingDefaults) {
      expect(dreaming, `docs/dreaming.md is missing the ${key} default`).toMatch(pattern)
    }
  })

  it('documents the management surface, import safety and capacity policy', () => {
    const readme = readText('README.md')
    for (const claim of ['新建记忆', 'Dream now', '撤销', '映射']) {
      expect(readme, claim).toContain(claim)
    }
    const configuration = readText('docs/configuration.md')
    expect(configuration).toContain('derived')
    expect(configuration).toContain('rebuildLookbackDays')
    const architecture = readText('docs/architecture.md')
    expect(architecture).toContain('memory/conflict')
    expect(architecture).toContain('session_cursors')
  })

  it('states the recent-work lookback window as 7 days', () => {
    expect(readText('README.md')).toContain('最近 7 天')
    expect(readText('README.en.md')).toMatch(/last 7 days/i)
    expect(readText('docs/dreaming.md')).toContain('默认 7 天')
  })

  it('states the recent-work entry cap as at most 3 entries', () => {
    expect(readText('README.md')).toContain('最多 3 条')
    expect(readText('README.en.md')).toMatch(/at most 3/i)
    expect(readText('docs/dreaming.md')).toContain('最多 3 条')
  })

  it('states the transient backoff delays as 60 and 180 seconds', () => {
    expect(readText('README.md')).toContain('60 秒、180 秒')
    expect(readText('README.en.md')).toMatch(/60 seconds, then 180 seconds/i)
    expect(readText('docs/dreaming.md')).toContain('60 秒')
    expect(readText('docs/dreaming.md')).toContain('180 秒')
  })

  it('documents the implemented dream recovery and worklog behavior in README files', () => {
    expectContains('README.md', [
      /启动恢复/,
      /冷会话/,
      /对账/,
      /queued/,
      /worklog/,
      /标题/,
      /正文/,
      /强密钥/,
      /退避/,
      /暂停/,
      /进程/,
      /重启/,
      /健康检查/,
      /证据分级/,
      /最近 7 天/,
      /pending/,
    ])
    expectContains('README.en.md', [
      /startup/i,
      /resume|recovery/i,
      /cold[- ]session/i,
      /reconcil/i,
      /queued/i,
      /worklog/i,
      /title/i,
      /body/i,
      /strong secret|secret/i,
      /backoff/i,
      /pause|paused/i,
      /process/i,
      /restart/i,
      /health check/i,
      /evidence/i,
      /last 7 days/i,
      /pending/,
    ])
  })

  it('covers dream recovery, failure handling and evidence rules in docs/dreaming.md', () => {
    expectContains('docs/dreaming.md', [
      /启动恢复/,
      /冷会话/,
      /失败分类/,
      /退避/,
      /暂停/,
      /重启/,
      /健康检查/,
      /证据分级/,
      /一条一主题/,
      /环境给不回来/,
      /pending/,
      /createdAt/,
    ])
  })

  it('documents only implemented behavior in DETAIL', () => {
    const detail = readText('docs/DETAIL.md')
    expect(detail).toContain('功能')
    expect(detail).toContain('使用')
    expect(detail).toContain('限制')
    expect(detail).toMatch(/启动恢复/)
    expect(detail).toMatch(/强密钥/)
    expect(detail).toMatch(/失败分类/)
    expect(detail).toMatch(/退避/)
    expect(detail).toMatch(/索引兜底/)
    expect(detail).toMatch(/pending/)
    expect(detail).not.toMatch(/D2|D3|后续候选|未来路线|transcript_read/)
  })

  it('records the planned fixes under Unreleased without inventing a release', () => {
    const changelog = readText('CHANGELOG.md')
    const start = changelog.indexOf('## [Unreleased]')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = changelog.indexOf('[Unreleased]:', start)
    expect(end).toBeGreaterThan(start)
    const unreleased = changelog.slice(start, end)

    expect(unreleased).toContain('### Fixed')
    expect(unreleased).toContain('### Changed')
    for (const pattern of [
      /queued dream/i,
      /worklog/i,
      /newline|literal \\n/i,
      /strong secret|secret/i,
      /backoff|failure class/i,
      /health/i,
      /turn worklog/i,
    ]) {
      expect(unreleased, `CHANGELOG Unreleased must mention ${String(pattern)}`).toMatch(pattern)
    }
    expect(unreleased).not.toMatch(/^## \[[0-9]/m)
    expect(unreleased).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/)
  })

  it.skipIf(!existsSync(pathOf(LOCAL_DESIGN_SPEC)))(
    'keeps the approved design at v2.7 and records the D1 and later decisions',
    () => {
      const design = readText(LOCAL_DESIGN_SPEC)
      expect(design).toContain('状态：已批准（v2.7，2026-11-21）')
      expect(design).toContain('### v2.4 用户评审决定')
      expect(design).toContain('### v2.5 用户评审决定')
      expect(design).toContain('### v2.6 用户评审决定')
      expect(design).toContain('### v2.7 用户评审决定')
      expect(design).toMatch(/2026-11-19 用户批准 D1/)
      expect(design).toMatch(/worklog\(turn\)[^\n]*补足/)
      expect(design).toMatch(/memory_organize/)
      expect(design).toContain('engines.dsh')
    },
  )

  it('does not overstate the 0.1.0 development status', () => {
    for (const relative of STATUS_SCAN) {
      const text = readText(relative)
      for (const claim of FORBIDDEN_CLAIMS) {
        expect(text, `${relative} must not contain "${claim}"`).not.toContain(claim)
      }
    }
  })

  it('keeps internal names and real host paths out of user-facing docs', () => {
    for (const relative of ['README.md', 'README.en.md']) {
      const text = readText(relative)
      for (const name of INTERNAL_NAMES) {
        expect(text, `${relative} must not mention internal name ${name}`).not.toContain(name)
      }
    }
    for (const relative of STATUS_SCAN) {
      const text = readText(relative)
      expect(text, `${relative} must not contain a real user path`).not.toMatch(
        /[A-Za-z]:[\\/](?:Users|Programs)[\\/]/i,
      )
    }
  })
})
