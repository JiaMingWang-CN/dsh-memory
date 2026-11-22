import { describe, expect, it } from 'vitest'
import { MemoryCapture } from '../../src/host/capture.ts'
import { detectStrongSecret, normalizeEscapedNewlines, redactText } from '../../src/host/redact.ts'
import { captureSession, turnEnd, turnStart, userMessage } from '../helpers/capture-events.ts'
import { openStore } from '../helpers/runner.ts'
import { openService } from '../helpers/service.ts'

const workspaceA = { key: 'c:/ws/a', root: 'C:/ws/a' }

function openWorkspaceService() {
  return openService({ workingDirectory: () => 'C:/ws/a' })
}

describe('memory write hygiene', () => {
  it('escaped newlines normalized', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Request\n测试\n\n## Result\n完成`
      expect(normalizeEscapedNewlines(body)).toBe('## Request\n测试\n\n## Result\n完成')
      const { record } = await host.service.write(
        { type: 'lesson', title: 'escaped newlines', body },
        workspaceA,
      )
      const stored = host.service.read(record.id, 'c:/ws/a')
      expect((stored.body.match(/\n/g) ?? []).length).toBeGreaterThanOrEqual(3)
      expect(stored.body).not.toContain('\\n')
      expect(stored.body).toBe('## Request\n测试\n\n## Result\n完成')
    } finally {
      await host.dispose()
    }
  })

  it('real newlines untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body =
        '## Request\nline one\n\n## Result\n完成\n\nExample: `print("a\\nb")`\nA literal \\n in prose.'
      const { record } = await host.service.write(
        { type: 'lesson', title: 'real newlines', body },
        workspaceA,
      )
      const stored = host.service.read(record.id, 'c:/ws/a')
      expect(stored.body).toBe(body)
      expect(Buffer.from(stored.body, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('body lines normalized', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Request\nline one\nline two\n## Result\ndone`
      const expected = '## Request\nline one\nline two\n## Result\ndone'
      expect(normalizeEscapedNewlines(body)).toBe(expected)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'body lines', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(expected)
    } finally {
      await host.dispose()
    }
  })

  it('list lines normalized', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Request\n- one\n- two\n## Result`
      const expected = '## Request\n- one\n- two\n## Result'
      expect(normalizeEscapedNewlines(body)).toBe(expected)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'list lines', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(expected)
    } finally {
      await host.dispose()
    }
  })

  it('single escape in prose untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`Use \n for newline`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'prose escape', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('two escapes without headings untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`printf("a\nb\nc")`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'two escapes', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('escaped backslash sequences untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`printf("a\\nb\\nc\\nd")`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'printf example', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('crlf escapes normalized', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Request\r\nfoo\r\n## Result\r\nbar`
      const expected = '## Request\nfoo\n## Result\nbar'
      expect(normalizeEscapedNewlines(body)).toBe(expected)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'crlf escapes', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(expected)
    } finally {
      await host.dispose()
    }
  })

  it('inline code body stays literal', async () => {
    const host = await openWorkspaceService()
    try {
      const body = '## Request\\nUse `printf("a\\nb")` inline\\n## Result'
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'inline code', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('relative path body stays literal', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Request\nSee src\new\notes\n## Result`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'relative path', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('windows paths untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`C:\new\notes\nconfig.txt`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'windows path', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('markdown with windows paths untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Paths\nC:\new\notes\nconfig.txt\n## Result\nok`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'markdown paths', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('windows path with spaces leaves whole body untouched', async () => {
    const host = await openWorkspaceService()
    try {
      const body = String.raw`## Paths\nC:\Program Files\notes\nconfig.txt\n## Result\nok`
      expect(normalizeEscapedNewlines(body)).toBe(body)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'spaced windows path', body },
        workspaceA,
      )
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('strong secret refused', async () => {
    const host = await openWorkspaceService()
    try {
      const before = host.service.status().counts.stored
      const secret = `sk-${'A'.repeat(40)}`
      expect(detectStrongSecret(secret)).toBe(true)
      const error = await host.service
        .write({ type: 'lesson', title: 'token note', body: `deploy with ${secret}` }, workspaceA)
        .then(
          () => undefined,
          (reason: unknown) => reason as { code?: string; message?: string },
        )
      expect(error).toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
      expect(error?.message).toBe(
        'memory content looks like a secret (private key, API key or token); record where it is configured instead',
      )
      expect(error?.message).not.toContain(secret)
      expect(host.service.status().counts.stored).toBe(before)
    } finally {
      await host.dispose()
    }
  })

  it('private key refused', async () => {
    const host = await openWorkspaceService()
    try {
      const before = host.service.status().counts.stored
      const body = '-----BEGIN RSA PRIVATE KEY-----\nMIIEexamplekeymaterial'
      expect(detectStrongSecret(body)).toBe(true)
      await expect(
        host.service.write({ type: 'lesson', title: 'key note', body }, workspaceA),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
      expect(host.service.status().counts.stored).toBe(before)
    } finally {
      await host.dispose()
    }
  })

  it('false positive accepted', async () => {
    const host = await openWorkspaceService()
    try {
      const body = 'Follow the sk-learn tutorial; the short token is abc123.'
      expect(detectStrongSecret(body)).toBe(false)
      const { record } = await host.service.write(
        { type: 'lesson', title: 'safe content', body },
        workspaceA,
      )
      expect(record.status).toBe('active')
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('sk-learn prose accepted', async () => {
    const host = await openWorkspaceService()
    try {
      const phrases = ['sk-learn-more-and-more-advanced', 'sk-learn-from-scratch-in-10-minutes']
      expect(detectStrongSecret(phrases.join(' '))).toBe(false)
      const body = `Read ${phrases[0]} and ${phrases[1]} before starting.`
      const { record } = await host.service.write(
        { type: 'lesson', title: 'learning note', body },
        workspaceA,
      )
      expect(record.status).toBe('active')
      expect(host.service.read(record.id, 'c:/ws/a').body).toBe(body)
    } finally {
      await host.dispose()
    }
  })

  it('sk key shapes detected', async () => {
    const host = await openWorkspaceService()
    try {
      const secrets = [
        `sk-${'z'.repeat(40)}`,
        `sk-${'A'.repeat(40)}`,
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
        `sk-${'A'.repeat(19)}_${'B'.repeat(20)}`,
        `sk-${'A'.repeat(19)}-${'B'.repeat(20)}`,
        'sk-12345678-1234-1234-1234-123456789012',
        'sk-abcdefgh-ijkl-mnop-qrst-uvwx12345678',
      ]
      for (const secret of secrets) expect(detectStrongSecret(secret)).toBe(true)
      expect(redactText(secrets[0]!)).toBe('[REDACTED]')
      expect(redactText('sk-learn-more-and-more-advanced')).toBe('sk-learn-more-and-more-advanced')
      expect(redactText('sk-learn-from-scratch-in-10-minutes')).toBe(
        'sk-learn-from-scratch-in-10-minutes',
      )
      expect(detectStrongSecret('sk-live-ABCDEFGHIJKLMNOP1234')).toBe(true)
      expect(detectStrongSecret('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX123')).toBe(true)
      await expect(
        host.service.write(
          { type: 'lesson', title: 'key shapes', body: `token ${secrets[0]}` },
          workspaceA,
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
    } finally {
      await host.dispose()
    }
  })

  it('tags strong secret refused', async () => {
    const host = await openWorkspaceService()
    try {
      const before = host.service.status().counts.stored
      await expect(
        host.service.write(
          {
            type: 'lesson',
            title: 'tagged note',
            body: 'clean body',
            tags: [`sk-${'C'.repeat(40)}7`],
          },
          workspaceA,
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
      expect(host.service.status().counts.stored).toBe(before)
    } finally {
      await host.dispose()
    }
  })

  it('source reference strong secret refused', async () => {
    const host = await openWorkspaceService()
    try {
      const before = host.service.status().counts.stored
      await expect(
        host.service.write(
          {
            type: 'lesson',
            title: 'sourced note',
            body: 'clean body',
            sourceRefs: [{ sessionId: 's1', quote: 'sk-live-ABCDEFGHIJKLMNOP1234' }],
          },
          workspaceA,
        ),
      ).rejects.toMatchObject({ code: 'MEMORY_INVALID_CONTENT' })
      expect(host.service.status().counts.stored).toBe(before)
    } finally {
      await host.dispose()
    }
  })

  it('capture still redacts', async () => {
    const opened = await openStore()
    try {
      const capture = new MemoryCapture({ store: opened.store, config: {} })
      const session = captureSession()
      capture.onSessionEvent(session, turnStart(1, 1))
      capture.onSessionEvent(
        session,
        userMessage(2, `deploy with sk-${'A'.repeat(40)} before shipping`),
      )
      capture.onSessionEvent(session, turnEnd(3))
      await capture.flush()
      const turn = opened.store.episodeList().find((episode) => episode.kind === 'turn')
      expect(turn?.prompt).toContain('[REDACTED]')
      expect(turn?.prompt).not.toContain('sk-')
    } finally {
      await opened.domain.close()
    }
  })
})
