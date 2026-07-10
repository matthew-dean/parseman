import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'

// `pick()` is intentionally NOT part of the public API. Build-inlining a `pick()` of an
// IMPORTED grammar cannot yet carry that grammar's ambient trivia across the module
// boundary, so the macro would diverge from the interpreter (see CHANGELOG 0.23.0). The
// implementation stays internal (src/compiler/linker.ts) for later exploration of that
// lowering; `compose()` is the public composition primitive. This guard prevents `pick`
// from being re-exported by accident before that work lands.
describe('public API surface', () => {
  it('does not expose pick()', () => {
    expect('pick' in P).toBe(false)
  })
  it('still exposes compose()', () => {
    expect(typeof (P as Record<string, unknown>).compose).toBe('function')
  })
})
