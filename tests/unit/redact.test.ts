import { describe, expect, it } from 'vitest'
import { redactField, redactSecrets, redactText } from '../../src/host/redact.ts'

describe('redactText', () => {
  it('replaces fictional secrets of every supported shape', () => {
    expect(redactText('token sk-live-ABCDEFGHIJKLMNOP1234')).toContain('[REDACTED]')
    expect(redactText('token sk-live-ABCDEFGHIJKLMNOP1234')).not.toContain('sk-live')
    expect(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toContain('[REDACTED]')
    expect(redactText('AKIAABCDEFGHIJKLMNOP')).toContain('[REDACTED]')
    expect(redactText('password=hunter2')).toBe('[REDACTED]')
    expect(redactText('token=abc123secret')).toBe('[REDACTED]')
    expect(redactText('a'.repeat(40))).toBe('[REDACTED]')
  })

  it('does not flag short hex, the bare word token, or a valueless env name', () => {
    expect(redactText('deadbeef')).toBe('deadbeef')
    expect(redactText('the token is stored in a keyring')).toBe('the token is stored in a keyring')
    expect(redactText('OPENAI_API_KEY')).toBe('OPENAI_API_KEY')
  })

  it('redacts JSON, env-prefixed and quoted credential assignments', () => {
    expect(redactText('{"password":"hunter2"}')).toContain('[REDACTED]')
    expect(redactText('{"password":"hunter2"}')).not.toContain('hunter2')
    expect(redactText('OPENAI_API_KEY=example-credential-value')).toBe('[REDACTED]')
    expect(redactText('DATABASE_PASSWORD=hunter2')).toBe('[REDACTED]')
    expect(redactText('password="hello world"')).toBe('[REDACTED]')
    expect(redactText('api_key: abc123value')).toBe('[REDACTED]')
  })
})

describe('redactField and redactSecrets', () => {
  it('report whether a field changed', () => {
    expect(redactField('clean text')).toEqual({ value: 'clean text', changed: false })
    expect(redactField('password=hunter2')).toEqual({ value: '[REDACTED]', changed: true })
  })

  it('redactSecrets matches redactText', () => {
    expect(redactSecrets('password=hunter2')).toBe(redactText('password=hunter2'))
  })
})
