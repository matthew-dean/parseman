/**
 * A dispatch key with no ASCII capital is its own fold: `asciiFoldKey` hands it
 * back without building it again a character at a time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asciiFoldKey } from '../../src/combinators/dispatch.ts'

describe('asciiFoldKey', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a key with no ASCII capital without building a string', () => {
    const fromCharCode = vi.spyOn(String, 'fromCharCode')
    expect(asciiFoldKey('important')).toBe('important')
    expect(asciiFoldKey('é-x')).toBe('é-x')
    expect(fromCharCode).not.toHaveBeenCalled()
  })

  it('lowers only ASCII capitals, wherever the first one falls', () => {
    expect(asciiFoldKey('IMPORTANT')).toBe('important')
    expect(asciiFoldKey('media-Query')).toBe('media-query')
    expect(asciiFoldKey('ÉtaT')).toBe('État')
    expect(asciiFoldKey('a[Z@')).toBe('a[z@')
  })
})
