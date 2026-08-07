import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'

// `compose()` is THE public composition primitive. There is no à-la-carte rule
// selection: `pick()` was removed outright — it was already withdrawn from the public
// API, unused by any consumer, and its trivia special-casing was the source of a
// shipped "pick() dropped the trivia it freezes" bug. This guard keeps it from being
// reintroduced as an export by accident.
describe('public API surface', () => {
  it('exposes compose()', () => {
    expect(typeof (P as Record<string, unknown>).compose).toBe('function')
  })
  it('does not expose pick()', () => {
    expect('pick' in P).toBe(false)
  })
})
