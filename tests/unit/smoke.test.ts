import { describe, expect, it } from 'vitest'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import defaultExport, { MemoryService } from '../../src/host/index.ts'

describe('host entry', () => {
  it('exposes a single MemoryService class as both default and named export', () => {
    expect(typeof MemoryService).toBe('function')
    expect(defaultExport).toBe(MemoryService)
  })

  it('extends TypertRemoteService', () => {
    expect(Object.getPrototypeOf(MemoryService.prototype)).toBe(TypertRemoteService.prototype)
  })
})
