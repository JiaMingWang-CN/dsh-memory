import { describe, expect, it } from 'vitest'
import { Config, resolveMemoryConfig } from '../../src/host/config.ts'

describe('memory config', () => {
  it('applies the documented defaults to an empty config', () => {
    const config = resolveMemoryConfig()
    expect(config.autoDream).toBe(false)
    expect(config.autoCaptureEpisodes).toBe(true)
    expect(config.refreshIndexOnChange).toBe(false)
    expect(config.indexMaxBytes).toBe(4096)
    expect(config.maxStoredMemories).toBe(25_000)
    expect(config.dreamModelMode).toBe('follow-session')
    expect(config.archivePurgePolicy).toBe('manual')
  })

  it('keeps explicit values instead of overwriting them', () => {
    const config = resolveMemoryConfig({ autoDream: true, indexMaxBytes: 8192 })
    expect(config.autoDream).toBe(true)
    expect(config.indexMaxBytes).toBe(8192)
  })

  it('rejects an unknown union value', () => {
    expect(() => resolveMemoryConfig({ dreamModelMode: 'nope' as never })).toThrow()
  })

  it('rejects unknown config fields', () => {
    expect(() => resolveMemoryConfig({ unknownField: 1 } as never)).toThrow(/unknown config field/)
  })

  it('rejects unknown fields through the standard-schema loader boundary', () => {
    const result = Config['~standard'].validate({ unknownField: 1 } as never) as {
      issues?: { message: string }[]
    }
    expect(result.issues?.[0]?.message).toContain('unknown config field')
  })
})
