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

  // The interpreted fuse is a DIAGNOSTIC engine, not a way to ship a parser. Publishing
  // it offered consumers a second engine over the same grammar; `isInterpretedFuse` was
  // an escape hatch with zero callers in `src/`. Both stay internal — a diagnostic that
  // wants them imports from `src/compiler/linker.ts`.
  //
  // Safe ONLY because composeLeaf's type is honest (see below). Withdrawing the
  // discriminator while the type still claimed `FusedRule` on both paths would leave a
  // dual shape nobody could detect.
  it.each(['fuseInterpreted', 'isInterpretedFuse'])('does not expose %s()', name => {
    expect(name in P).toBe(false)
  })
})

// `composeLeaf()` returns compiled functions under the macro and combinators without it.
// The declared element type must admit BOTH, or a caller can hold an interpreted fuse
// while the type promises compiled functions — the exact defect that made withdrawing
// `isInterpretedFuse` unsafe. This asserts the runtime path against the declared type:
// `Runnable` accepts the combinator map, `FusedRule` would not.
describe('composeLeaf types both engines honestly', () => {
  const build = (): Record<string, P.Runnable> => P.composeLeaf([
    P.rules(() => ({ Tail: P.literal('y') })),
    P.rules(g => ({ Doc: P.sequence(P.literal('x'), g.Tail!) })),
  ])

  it('the un-macro\'d runtime path yields combinators, not fused functions', () => {
    const g = build()
    expect(typeof g.Doc).toBe('object')
    expect(typeof g.Doc).not.toBe('function')
  })

  it('and what it yields is still directly runnable', () => {
    expect(P.run(build().Doc!, 'xy').ok).toBe(true)
  })
})
