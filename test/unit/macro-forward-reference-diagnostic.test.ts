/**
 * A factory body that fails must say WHY, and the dominant cause must be named.
 *
 * `const A = node('A', B, …)` above `const B = …` is a JavaScript temporal dead zone,
 * not a macro limitation — the interpreter throws
 * `ReferenceError: Cannot access 'B' before initialization` on the very same source.
 * `g.B` is order-free, so converting a `g.` reference to a bare const can only move
 * DOWN the file. The macro used to report this as a generic "isn't statically
 * evaluable", and through composeLeaf as a complaint about the ARGUMENT SHAPE
 * (`final argument must be a local rules() map`) — a message pointing at the wrong
 * cause, which was twice reported as a grammar defect.
 */
import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'
import { rules, node, regex, sequence, choice, literal } from '../../src/index.ts'

const IMP = `import { rules, node, choice, sequence, regex, literal, many, composeLeaf } from 'parseman' with { type: 'macro' }`

const warnings = (body: string): string[] => {
  const r = transformMacro(`${IMP}\n${body}`.trim(), 'test.ts', new Set(['parseman']))
  expect(r, 'macro did not run').not.toBeNull()
  return r!.warnings ?? []
}

describe('a forward-referenced const is diagnosed, not generically refused', () => {
  it('names the binding, the forward reference, and both fixes', () => {
    const w = warnings(`
export const g = rules((g) => {
  const Val = node('Val', Tok, (c) => c[0])
  const Tok = regex(/[a-z]+/)
  return { Val, Tok }
})`)
    expect(w).toHaveLength(1)
    const m = w[0]!
    expect(m, 'names the failing binding').toContain('`Val`')
    expect(m, 'names the forward reference').toContain('`Tok`')
    expect(m, 'says it is a forward reference').toMatch(/before its declaration/)
    expect(m, 'offers the order-free alternative').toContain('g.Tok')
  })

  it('the interpreter agrees — this source is a real temporal dead zone', () => {
    expect(() =>
      rules(() => {
        // @ts-expect-error TS2448/TS2454: `Tok` is used before its declaration. The
        // expect-error is the point: TypeScript rejects this source, the interpreter
        // throws on it, and the macro refuses it — three agreeing signals that the
        // constraint is JavaScript's, not parseman's. Only the macro's message was wrong.
        const Val = node('Val', Tok, (c: readonly unknown[]) => c[0])
        const Tok = regex(/[a-z]+/)
        return { Val, Tok }
      })
    ).toThrow(/Cannot access 'Tok' before initialization/)
  })

  it('mutual recursion via bare consts is impossible in ANY order, and says so', () => {
    const w = warnings(`
export const g = rules((g) => {
  const A = sequence(literal('('), choice(B, regex(/[a-z]+/)), literal(')'))
  const B = sequence(literal('['), choice(A, regex(/[a-z]+/)), literal(']'))
  return { A, B }
})`)
    expect(w[0]!).toContain('`B`')
    expect(w[0]!).toMatch(/before its declaration/)
    // The same shape via g.X builds, in the macro AND the interpreter.
    expect(warnings(`
export const g = rules((g) => ({
  A: sequence(literal('('), choice(g.B, regex(/[a-z]+/)), literal(')')),
  B: sequence(literal('['), choice(g.A, regex(/[a-z]+/)), literal(']')),
}))`)).toEqual([])
    expect(() =>
      rules((g: Record<string, never>) => ({
        A: sequence(literal('('), choice(g.B!, regex(/[a-z]+/)), literal(')')),
        B: sequence(literal('['), choice(g.A!, regex(/[a-z]+/)), literal(']')),
      }))
    ).not.toThrow()
  })

  it('a const referenced only AFTER its declaration converts cleanly', () => {
    // This is the safe direction of the g.X -> bare const sweep.
    expect(warnings(`
export const g = rules((g) => {
  const Tok = regex(/[a-z]+/)
  const Val = node('Val', Tok, (c) => c[0])
  return { Val, Tok }
})`)).toEqual([])
  })

  it('dropping a const from the returned map is NOT what breaks a sweep', () => {
    expect(warnings(`
export const g = rules((g) => {
  const Tok = regex(/[a-z]+/)
  const Val = node('Val', Tok, (c) => c[0])
  return { Val }
})`)).toEqual([])
  })

  it('composeLeaf hard-fails, and the thrown cause names the unresolved leaf', () => {
    // composeLeaf produces NO artifact rather than a bad one, so the build stops here.
    // That is right; what was wrong is that the cause named the argument SHAPE.
    let msg = ''
    try {
      warnings(`export const g = composeLeaf([someImported, notDeclaredHere])`)
    } catch (e) { msg = (e as Error).message }
    expect(msg, 'composeLeaf must still hard-fail').toContain('must macro-fuse')
    expect(msg, 'names the unresolved binding').toContain('notDeclaredHere')
    expect(msg, 'says what it must be, in this module').toContain('rules(...)')
    expect(msg, 'no longer a bare shape complaint')
      .not.toMatch(/final argument must be a local rules\(\) map/)
  })
})
