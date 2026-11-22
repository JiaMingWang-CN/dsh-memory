import { describe, expect, it } from 'vitest'
import {
  buildWorklogContent,
  createTurnWorklog,
  shouldCreateWorklog,
} from '../../src/host/worklog.ts'
import type { CaptureEpisodeInput } from '../../src/host/capture.ts'
import { openStore } from '../helpers/runner.ts'

function episode(overrides: Partial<CaptureEpisodeInput> = {}): CaptureEpisodeInput {
  return {
    kind: 'turn',
    sessionId: 's1',
    workspaceKey: 'ws-a',
    workspaceRoot: 'C:/ws/a',
    turn: 1,
    sourceSeqs: [1],
    files: [],
    outcome: 'completed',
    ...overrides,
  }
}

describe('worklog file change', () => {
  it('creates an active system-derived turn worklog when files changed', async () => {
    const { store } = await openStore()
    const record = await createTurnWorklog(store, {}, episode({ files: ['C:/a.ts'] }))
    expect(record).toBeDefined()
    expect(record?.type).toBe('worklog')
    expect(record?.worklogKind).toBe('turn')
    expect(record?.origin).toBe('system')
    expect(record?.ownership).toBe('derived')
    expect(record?.status).toBe('active')
  })
})

describe('worklog no output', () => {
  it('does not create a worklog for a plain question/answer turn', async () => {
    const { store } = await openStore()
    const record = await createTurnWorklog(
      store,
      {},
      episode({ prompt: 'what is x?', assistantFinal: 'x is y' }),
    )
    expect(record).toBeUndefined()
    expect(shouldCreateWorklog(episode())).toBe(false)
  })
})

describe('worklog off', () => {
  it('never creates a worklog when worklogCapture is off', async () => {
    const { store } = await openStore()
    const record = await createTurnWorklog(
      store,
      { worklogCapture: 'off' },
      episode({ files: ['C:/a.ts'] }),
    )
    expect(record).toBeUndefined()
  })
})

describe('worklog content', () => {
  it('uses the first prompt line as a bounded title and keeps raw tool arguments out', async () => {
    const { store } = await openStore()
    const longLine = 'topic '.repeat(30).trim()
    const record = await createTurnWorklog(
      store,
      {},
      episode({
        prompt: `${longLine}\nsecond line`,
        files: ['C:/a.ts'],
        toolFailures: ['bash: E1'],
      }),
    )
    expect(record).toBeDefined()
    expect(record?.title).toBe([...longLine].slice(0, 79).join('') + '…')
    expect([...record!.title].length).toBe(80)
    expect(record?.body).not.toContain('{"file_path"')
    expect(Buffer.byteLength(record!.body, 'utf8')).toBeLessThanOrEqual(4096)
  })
})

describe('worklog defensive redaction', () => {
  it('redacts secrets in episode files before writing the body', async () => {
    const { store } = await openStore()
    const record = await createTurnWorklog(
      store,
      {},
      episode({ files: ['C:/tmp/password=hunter2.ts'] }),
    )
    expect(record).toBeDefined()
    expect(record?.body).toContain('C:/tmp/[REDACTED]')
    expect(record?.body).not.toContain('hunter2')
  })
})

describe('worklog title quality', () => {
  it('question prompt uses result title', () => {
    const content = buildWorklogContent(
      episode({
        prompt: '最大上下文不是512K吗？',
        assistantFinal: '对，这两个模型在接口上标称的最大上下文都是 512K…',
      }),
    )
    expect(content.title.endsWith('？')).toBe(false)
    expect(content.title).not.toBe('最大上下文不是512K吗？')
    expect(content.title).toContain('512K')
  })

  it('markdown stripped', () => {
    const content = buildWorklogContent(
      episode({
        assistantFinal: '## 结论\n**修复完成**：worklog 标题与正文已按计划调整。',
      }),
    )
    expect(content.title).toBe('修复完成')
  })
})

describe('worklog title robustness', () => {
  it('skips ordered list markers', () => {
    const content = buildWorklogContent(
      episode({
        assistantFinal: '1. 检查代码\n2. 修复问题',
        prompt: '请执行 plan06',
      }),
    )
    expect(content.title).toBe('检查代码')
  })

  it('skips fenced code and falls back to the prompt', () => {
    const content = buildWorklogContent(
      episode({
        assistantFinal: '```ts\nconst answer = 42\n```',
        prompt: '请检查 TypeScript 实现',
      }),
    )
    expect(content.title).toBe('请检查 TypeScript 实现')
    expect(content.title).not.toBe('ts')
  })

  it('skips table rows and falls back to the prompt', () => {
    const content = buildWorklogContent(
      episode({
        assistantFinal: '| 文件 | 修改 |\n| --- | --- |\n| a.ts | 修复 |',
        prompt: '请整理变更说明',
      }),
    )
    expect(content.title).toBe('请整理变更说明')
    expect(content.title.startsWith('|')).toBe(false)
  })

  it('skips generic completion sentences', () => {
    const content = buildWorklogContent(
      episode({
        assistantFinal: '完成。具体修改如下：修复登录按钮的校验逻辑。',
        prompt: '请修复登录校验',
      }),
    )
    expect(content.title).toBe('修复登录按钮的校验逻辑')
    expect(content.title).not.toBe('完成')
  })

  it('skips heading-symbol-only lines', () => {
    const content = buildWorklogContent(
      episode({
        assistantFinal: '---\n***\n###\n**修复完成**：正文',
        prompt: '请修复',
      }),
    )
    expect(content.title).toBe('修复完成')
  })

  it('recognizes question endings as questions', () => {
    for (const assistantFinal of ['这样可以吗', '这样可以呢', '这样可以?', '这样可以？']) {
      const content = buildWorklogContent(
        episode({
          assistantFinal,
          prompt: '请确认最终配置',
        }),
      )
      expect(content.title).toBe('请确认最终配置')
    }
  })
})

describe('worklog body budget', () => {
  it('long prompt keeps result', () => {
    const assistantFinal = '结论已经完成并且结论足够简短'
    const content = buildWorklogContent(
      episode({
        prompt: '长'.repeat(6000),
        assistantFinal,
      }),
    )
    expect(content.body).toContain('## Result')
    expect(content.body).toContain(assistantFinal)
    expect(content.body.slice(content.body.indexOf('## Request')).endsWith('…[truncated]')).toBe(
      true,
    )
    expect(Buffer.byteLength(content.body, 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('long answer marker', () => {
    const content = buildWorklogContent(
      episode({
        prompt: '请给出结论',
        assistantFinal: '答'.repeat(3000),
      }),
    )
    expect(content.body).toContain('…[truncated]')
    const resultStart = content.body.indexOf('## Result\n') + '## Result\n'.length
    const resultEnd = content.body.indexOf('\n\n## Request')
    const resultBytes = Buffer.byteLength(content.body.slice(resultStart, resultEnd), 'utf8')
    expect(resultBytes).toBeGreaterThanOrEqual(512)
    expect(resultBytes).toBeLessThanOrEqual(2048)
  })

  it('files budget', () => {
    const files = Array.from({ length: 100 }, (_, index) => `C:/workspace/src/file-${index}.ts`)
    const content = buildWorklogContent(
      episode({
        prompt: '请修改这些文件',
        assistantFinal: '修改完成。',
        files,
      }),
    )
    expect(content.body).toContain('## Result')
    const filesStart = content.body.indexOf('## Files')
    expect(filesStart).toBeGreaterThanOrEqual(0)
    const entries = content.body
      .slice(filesStart)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('- '))
    expect(entries.length).toBeLessThanOrEqual(20)
  })

  it('no assistant final', () => {
    const content = buildWorklogContent(
      episode({
        prompt: '请修改两个文件',
        files: ['C:/workspace/src/a.ts', 'C:/workspace/src/b.ts'],
      }),
    )
    expect(content.body).not.toContain('## Result')
    expect(content.body).toContain('## Request')
    expect(content.body).toContain('## Files')
  })
})
