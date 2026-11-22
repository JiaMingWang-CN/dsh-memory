import { describe, expect, it } from 'vitest'
import { resolveMemoryConfig, type MemoryConfig } from '../../src/host/config.ts'

/** Assert the three automation flags keep their documented default-off posture. */
function assertDisabledDefaults(config: MemoryConfig): void {
  expect(config.autoDream).toBe(false)
  expect(config.refreshIndexOnChange).toBe(false)
  expect(config.autoCaptureEpisodes).toBe(true)
}

describe('config flag defaults', () => {
  it('leaves automatic dreaming and index refresh off, episode capture on', () => {
    assertDisabledDefaults(resolveMemoryConfig())
  })

  it('keeps defaults when an unrelated field is patched', () => {
    assertDisabledDefaults(resolveMemoryConfig({ indexMaxBytes: 2048 }))
  })

  it('honours explicit opt-ins', () => {
    const config = resolveMemoryConfig({ autoDream: true, refreshIndexOnChange: true })
    expect(config.autoDream).toBe(true)
    expect(config.refreshIndexOnChange).toBe(true)
    expect(config.autoCaptureEpisodes).toBe(true)
  })

  it('rejects unknown config fields', () => {
    expect(() => resolveMemoryConfig({ nope: true } as unknown as Partial<MemoryConfig>)).toThrow(
      /unknown config field/,
    )
  })
})
