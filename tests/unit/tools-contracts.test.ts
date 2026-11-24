import { describe, expect, it } from 'vitest'
import {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { openService } from '../helpers/service.ts'
import { getTool, toolExec } from '../helpers/tool.ts'

const TOOL_NAMES = [
  'memory_search',
  'memory_read',
  'memory_write',
  'memory_forget',
  'memory_dream',
  'memory_organize',
] as const

function assertStructuredResult(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  value: unknown,
): void {
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)
  expect(validateJsonSchemaValue(tool.output.schema, value)).toEqual([])
  const rendered = tool.output.render(args, value as Parameters<typeof tool.output.render>[1])
  expect(rendered).toHaveLength(1)
  expect(rendered[0]?.type).toBe('text')
  expect(JSON.parse((rendered[0] as { text: string }).text)).toEqual(value)
}

describe('memory tool structured output contracts', () => {
  it('declares strict object output schemas and concurrency safety metadata', async () => {
    const host = await openService({ workingDirectory: () => 'C:/ws/a' })
    try {
      for (const name of TOOL_NAMES) {
        const tool = getTool(host.tools, name)
        expect(() => assertObjectJsonSchema(tool.output.schema)).not.toThrow()
        const schema = tool.output.schema as { type?: string; additionalProperties?: boolean }
        expect(schema.type).toBe('object')
        expect(schema.additionalProperties).toBe(false)
      }

      expect(getTool(host.tools, 'memory_search').isConcurrencySafe?.({})).toBe(true)
      expect(getTool(host.tools, 'memory_read').isConcurrencySafe?.({ id: 'mem-1' })).toBe(true)
      for (const mutating of ['memory_write', 'memory_forget', 'memory_dream', 'memory_organize']) {
        expect(getTool(host.tools, mutating).isConcurrencySafe).toBeUndefined()
      }
    } finally {
      await host.dispose()
    }
  })

  it('returns structured objects and JSON text renders for every memory tool', async () => {
    const host = await openService({ workingDirectory: () => 'C:/ws/a' })
    try {
      const writeTool = getTool(host.tools, 'memory_write')
      const writeArgs = {
        type: 'lesson',
        title: 'structured output check',
        body: 'verify structured object return',
      }
      const written = (await writeTool.execute(
        writeArgs,
        toolExec('memory_write', 'agent-a', 'session-1'),
      )) as { id: string }
      assertStructuredResult(writeTool, writeArgs, written)

      const searchTool = getTool(host.tools, 'memory_search')
      const searchArgs = { query: 'structured' }
      const searched = await searchTool.execute(searchArgs, toolExec('memory_search', 'agent-a'))
      assertStructuredResult(searchTool, searchArgs, searched)

      const readTool = getTool(host.tools, 'memory_read')
      const readArgs = { id: written.id }
      const read = await readTool.execute(readArgs, toolExec('memory_read', 'agent-a'))
      assertStructuredResult(readTool, readArgs, read)

      const dreamTool = getTool(host.tools, 'memory_dream')
      const dreamQueued = await dreamTool.execute({}, toolExec('memory_dream', 'agent-a'))
      assertStructuredResult(dreamTool, {}, dreamQueued)
      expect((dreamQueued as { status: string }).status).toBe('queued')

      const dreamInvalidEpisodes = await dreamTool.execute(
        { max_episodes: 0 },
        toolExec('memory_dream', 'agent-a'),
      )
      assertStructuredResult(dreamTool, { max_episodes: 0 }, dreamInvalidEpisodes)
      expect((dreamInvalidEpisodes as { status: string; dreamId: null }).status).toBe('error')

      const dreamInvalidSince = await dreamTool.execute(
        { since: 'not-a-date' },
        toolExec('memory_dream', 'agent-a'),
      )
      assertStructuredResult(dreamTool, { since: 'not-a-date' }, dreamInvalidSince)
      expect((dreamInvalidSince as { status: string }).status).toBe('error')

      const organizeTool = getTool(host.tools, 'memory_organize')
      const organized = await organizeTool.execute({}, toolExec('memory_organize', 'agent-a'))
      assertStructuredResult(organizeTool, {}, organized)
      expect((organized as { status: string }).status).toBe('queued')

      const forgetTool = getTool(host.tools, 'memory_forget')
      const forgetArgs = { id: written.id, reason: 'done' }
      const forgotten = await forgetTool.execute(forgetArgs, toolExec('memory_forget', 'agent-a'))
      assertStructuredResult(forgetTool, forgetArgs, forgotten)
    } finally {
      await host.dispose()
    }
  })

  it('validates structured error objects when workspace is missing', async () => {
    const host = await openService({ workingDirectory: () => '' })
    try {
      const dreamTool = getTool(host.tools, 'memory_dream')
      const dreamErr = await dreamTool.execute({}, toolExec('memory_dream', 'agent-a'))
      assertStructuredResult(dreamTool, {}, dreamErr)
      expect(dreamErr).toEqual({
        dreamId: null,
        status: 'error',
        reason: 'no working directory',
      })

      const organizeTool = getTool(host.tools, 'memory_organize')
      const organizeErr = await organizeTool.execute({}, toolExec('memory_organize', 'agent-a'))
      assertStructuredResult(organizeTool, {}, organizeErr)
      expect(organizeErr).toEqual({
        dreamId: null,
        status: 'error',
        reason: 'no working directory',
      })
    } finally {
      await host.dispose()
    }
  })

  it('passes DSH ToolExecutionPipeline output validation and projection end-to-end', async () => {
    const host = await openService({ workingDirectory: () => 'C:/ws/a' })
    try {
      const pipeline = new ToolExecutionPipeline(host.ctx)
      const agent = { id: 'agent-a', session: { id: 'session-1' } } as never
      const invoke = async (name: string, args: Record<string, unknown>, callId: string) => {
        const prepared = await pipeline.prepare({
          callId: callId as never,
          name,
          arguments: args,
          agent,
          signal: new AbortController().signal,
        })
        expect(prepared.kind).toBe('dispatch')
        if (prepared.kind !== 'dispatch') throw new Error('expected dispatch')
        const outcome = await pipeline.dispatch(prepared.exec)
        return pipeline.complete(prepared.exec, outcome)
      }

      const written = await invoke(
        'memory_write',
        { type: 'lesson', title: 'pipeline check', body: 'pipeline body' },
        'call-write',
      )
      expect(written.isError, written.isError ? written.error.message : '').toBe(false)
      if (written.isError) throw new Error(written.error.message)
      expect(typeof written.value).toBe('object')
      const writtenId = (written.value as { id: string }).id
      expect(written.content).toEqual([{ type: 'text', text: JSON.stringify(written.value) }])

      const searched = await invoke('memory_search', {}, 'call-search')
      expect(searched.isError, searched.isError ? searched.error.message : '').toBe(false)
      if (searched.isError) throw new Error(searched.error.message)
      expect(Array.isArray((searched.value as { results: unknown[] }).results)).toBe(true)

      const read = await invoke('memory_read', { id: writtenId }, 'call-read')
      expect(read.isError, read.isError ? read.error.message : '').toBe(false)

      const dreamed = await invoke('memory_dream', {}, 'call-dream')
      expect(dreamed.isError, dreamed.isError ? dreamed.error.message : '').toBe(false)

      const organized = await invoke('memory_organize', {}, 'call-organize')
      expect(organized.isError, organized.isError ? organized.error.message : '').toBe(false)

      const forgotten = await invoke('memory_forget', { id: writtenId }, 'call-forget')
      expect(forgotten.isError, forgotten.isError ? forgotten.error.message : '').toBe(false)
    } finally {
      await host.dispose()
    }
  })
})
