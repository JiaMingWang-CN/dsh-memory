import { describe, expect, it } from 'vitest'
import { MEMORY_COMMAND_USAGE } from '../../src/host/command.ts'
import { openService } from '../helpers/service.ts'

type Host = Awaited<ReturnType<typeof openService>>
const agent = { id: 'agent-a' }

async function run(host: Host, line: string): Promise<any> {
  const commands = (
    host.ctx as unknown as {
      commands: { execute(a: unknown, l: string): Promise<{ result: any } | undefined> }
    }
  ).commands
  const execution = await commands.execute(agent, line)
  if (execution === undefined) throw new Error('command did not resolve')
  return execution.result
}

describe('memory command set', () => {
  it('handles status, search, export, forget and rejects unknown subcommands', async () => {
    const host = await openService()
    const written = await host.service.write(
      { type: 'lesson', title: '构建前先跑 typecheck', body: '构建之前先执行 typecheck' },
      { key: 'c:/ws/a', root: 'C:/ws/a' },
    )
    // workspace identity in this fake host normalizes to C:/ws/a
    const workspaceKey = written.record.scope.kind === 'workspace' ? written.record.scope.key : ''

    const status = await run(host, '/memory status')
    expect(status.kind).toBe('success')
    const statusPayload = JSON.parse(status.text)
    expect(statusPayload.counts.active).toBeGreaterThanOrEqual(1)
    expect(statusPayload.dreamQueue).toEqual({ paused: false })

    const search = await run(host, '/memory search 构建')
    expect(search.kind).toBe('success')
    expect(JSON.parse(search.text).results.length).toBeGreaterThanOrEqual(1)

    const exported = await run(host, '/memory export')
    expect(exported.kind).toBe('success')
    expect(JSON.parse(exported.text).memories).toBeGreaterThanOrEqual(1)

    const forget = await run(host, `/memory forget ${written.record.id}`)
    expect(forget.kind).toBe('success')
    expect(JSON.parse(forget.text).status).toBe('archived')

    const unknown = await run(host, '/memory bogus')
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toBe(MEMORY_COMMAND_USAGE)
    expect(workspaceKey).toBeTruthy()
    await host.dispose()
  })
})
