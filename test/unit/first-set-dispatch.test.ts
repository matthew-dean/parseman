/**
 * First-set soundness + first-char dispatch correctness.
 *
 * Regression repros for two linked bugs found chasing the compiled-grammar
 * dispatch win:
 *
 *  1. `sequence()` computed its first-set from `parsers[0]` ALONE, ignoring that a
 *     nullable leading term (`optional(…)` / `many(…)`) lets a LATER term's first
 *     char start the whole sequence. That under-approximates the first-set.
 *
 *  2. Because first-char dispatch trusts the first-set, an under-approximated set
 *     makes an ordered `choice` SKIP a valid arm — silently dropping a legal parse
 *     (e.g. a Less `@{x}{}` interpolated selector, which starts with `@` reached
 *     through `sequence(optional(/[.#]/), /@\{…\}/, …)`).
 *
 * Both are RED before the `sequenceFirstSet` nullable-prefix fix and GREEN after.
 */
import { describe, it, expect } from 'vitest'
import { sequence, optional, oneOrMore, many, choice, literal, regex, node, rules, compile, parse, transform, compose } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import type { Combinator, FirstSet } from '../../src/index.ts'

const inFirstSet = (fs: FirstSet, code: number): boolean =>
  fs.kind === 'any' || (fs.kind === 'ranges' && fs.ranges.some(r => code >= r.lo && code <= r.hi))

const cst = (type: string) => (ch: readonly unknown[], _r: unknown, span: { start: number; end: number }) =>
  ({ _tag: 'node' as const, type, span, children: [...ch] })

// ---------------------------------------------------------------------------
// 1. sequence first-set unions through the nullable prefix
// ---------------------------------------------------------------------------
describe('sequence first-set — nullable prefix', () => {
  it('includes a later term’s first char when the leading term is optional', () => {
    // `.`(46) from the optional, AND `@`(64) from the term after it.
    const seq = sequence(optional(regex(/[.#]/)), regex(/@\{x\}/))
    const fs = seq._meta.firstSet
    expect(inFirstSet(fs, 46)).toBe(true)   // '.'
    expect(inFirstSet(fs, 35)).toBe(true)   // '#'
    expect(inFirstSet(fs, 64)).toBe(true)   // '@'  ← was DROPPED before the fix
  })

  it('unions through a many() prefix too, and stops at the first non-nullable term', () => {
    // many(letters) is nullable → include ':'(58); then literal(':') is NOT nullable
    // → stop (do not leak the trailing '}'.
    const seq = sequence(many(regex(/[a-z]+/)), literal(':'), literal('}'))
    const fs = seq._meta.firstSet
    expect(inFirstSet(fs, 97)).toBe(true)   // 'a' (letters)
    expect(inFirstSet(fs, 58)).toBe(true)   // ':'
    expect(inFirstSet(fs, 125)).toBe(false) // '}' must NOT leak past the non-nullable ':'
  })

  it('a non-nullable leading term keeps the first-set tight (no over-union)', () => {
    const seq = sequence(literal('x'), regex(/@\{y\}/))
    const fs = seq._meta.firstSet
    expect(inFirstSet(fs, 120)).toBe(true)  // 'x'
    expect(inFirstSet(fs, 64)).toBe(false)  // '@' must NOT be included
  })

  // matchesEmpty (nullable) edge cases, exercised through the sequence union.
  it('a `?`-quantified regex leader is nullable → unions the next term', () => {
    const seq = sequence(regex(/[.#]?/), regex(/@\{y\}/))
    const fs = seq._meta.firstSet
    expect(inFirstSet(fs, 46)).toBe(true)   // '.'
    expect(inFirstSet(fs, 64)).toBe(true)   // '@' reached through the nullable regex
  })

  it('a regex with an INTERNAL `?` but no empty match is NOT nullable (precise empty-test)', () => {
    // `@\{-?[a-z]+\}` contains `?` (in `-?`) but cannot match empty — a crude
    // "source contains ? or *" heuristic would wrongly treat it nullable and leak
    // the next term's first char. The precise empty-test keeps the set tight.
    const seq = sequence(regex(/@\{-?[a-z]+\}/), literal(';'))
    const fs = seq._meta.firstSet
    expect(inFirstSet(fs, 64)).toBe(true)   // '@'
    expect(inFirstSet(fs, 59)).toBe(false)  // ';' must NOT leak
  })

  it('oneOrMore(optional(x)) is nullable → unions past it; literal("") is nullable', () => {
    const seq1 = sequence(oneOrMore(optional(regex(/x/))), regex(/@\{y\}/))
    expect(inFirstSet(seq1._meta.firstSet, 64)).toBe(true)   // '@' reached (inner optional nullable)
    const seq2 = sequence(literal(''), regex(/@\{y\}/))
    expect(inFirstSet(seq2._meta.firstSet, 64)).toBe(true)   // empty literal is nullable
  })

  it('a choice with a nullable arm is nullable → the sequence unions past it', () => {
    const seq = sequence(choice(literal('x'), optional(regex(/y/))), regex(/@\{z\}/))
    expect(inFirstSet(seq._meta.firstSet, 64)).toBe(true)    // '@' reached (choice can match empty)
  })
})

// ---------------------------------------------------------------------------
// 2. compiled first-char dispatch must not drop a nullable-prefix arm
// ---------------------------------------------------------------------------
describe('compiled dispatch — nullable-prefix choice arm', () => {
  // Mirrors the Less shape: an at-rule arm and an interpolated-selector arm that
  // both begin with `@`, the latter reached through `optional(/[.#]/)`.
  const makeGrammar = () => rules(g => ({
    stmt: choice(g.atRule, g.interpSel),
    atRule: node('AtRule', sequence(regex(/@[a-z]+/), literal(';')), cst('AtRule')),
    interpSel: node('InterpSel',
      sequence(optional(regex(/[.#]/)), regex(/@\{[a-z]+\}/), literal('{}')), cst('InterpSel')),
  }))

  it('routes `@{x}{}` to the interpolated-selector arm (not dropped)', () => {
    const { stmt } = makeGrammar()
    const c = compile(stmt as Combinator<unknown>)
    // RED before the fix: interpSel's first-set omitted `@`, so dispatch skipped it
    // and the parse failed ("unexpected input").
    expect(c.parse('@{x}{}').ok).toBe(true)
    expect(c.parse('@media;').ok).toBe(true)   // the other `@` arm still works
  })

  it('interpreter and compiled agree on the nullable-prefix arm', () => {
    // The interpreter's `firstMatch` tries every arm (no pruning); the COMPILED
    // firstMatch prunes by first-set. An under-approximated first-set makes them
    // DISAGREE on `@{x}{}` (interp succeeds, compiled drops) — parity catches it.
    const interp = parse(makeGrammar().stmt as Combinator<unknown>, '@{x}{}')
    const comp = compile(makeGrammar().stmt as Combinator<unknown>).parse('@{x}{}')
    expect(interp.ok).toBe(true)
    expect(comp.ok).toBe(true)   // RED before the fix (compiled dropped it → mismatch)
  })
})

// ---------------------------------------------------------------------------
// 3. Interpreter DISJOINT dispatch must not drop a nullable-prefix arm
//    (the interpreter prunes by first-set on the disjoint path — choice.ts)
// ---------------------------------------------------------------------------
describe('interpreter disjoint dispatch — nullable-prefix arm', () => {
  // interp starts with `.`/`#`/`@` (via optional prefix); digits with 0-9 →
  // DISJOINT → the interpreter takes its O(1) first-char dispatch path.
  const makeStmt = () => choice(
    transform(sequence(optional(regex(/[.#]/)), regex(/@\{[a-z]+\}/)), x => x),
    regex(/[0-9]+/),
  )
  it('routes `@{x}` through interpreter disjoint dispatch (not dropped)', () => {
    // RED before the fix: interp's first-set omitted `@`, disjoint dispatch found
    // no arm for `@`, and the fall-through returns failure WITHOUT retrying arms.
    expect(parse(makeStmt() as Combinator<unknown>, '@{x}').ok).toBe(true)
    expect(parse(makeStmt() as Combinator<unknown>, '.@{y}').ok).toBe(true)
    expect(parse(makeStmt() as Combinator<unknown>, '42').ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Macro (build-time compiled) path — inline disjoint arms dispatch, and the
//    nullable-prefix arm must still be reachable.
// ---------------------------------------------------------------------------
describe('macro-compiled dispatch — nullable-prefix arm', () => {
  const evalMacro = (src: string): Record<string, (i: string, p: number, c: Record<string, unknown>) => { ok: boolean; span: { end: number } }> => {
    const out = transformMacro(src, '/pkg/fs.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    // eslint-disable-next-line no-new-func
    return new Function(
      out.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn grammar',
    )() as ReturnType<typeof evalMacro>
  }

  it('macro-compiled compose reaches the `@`-led ref arm (fuse substitution + fix)', () => {
    // The real jess build path: transformMacro of compose([...]) → emitFusedSource
    // → the `/*@FS:interp:code@*​/` placeholder is substituted with interp's
    // (fixed, `@`-including) first-set. RED before the fix: interp's fused first-set
    // omitted `@` and macro-compiled dispatch dropped `@{x}`.
    const src = `import { rules, choice, sequence, optional, regex, compose } from 'parseman' with { type: 'macro' }
export const grammar = compose([rules(g => ({
  stmt: choice(g.interp, g.digits),
  interp: sequence(optional(regex(/[.#]/)), regex(/@\\{[a-z]+\\}/)),
  digits: regex(/[0-9]+/),
}))])`
    const g = evalMacro(src)
    expect(g.stmt!('@{x}', 0, {}).ok).toBe(true)
    expect(g.stmt!('.@{y}', 0, {}).ok).toBe(true)
    expect(g.stmt!('42', 0, {}).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Compose / fuse path (the real jess shape) — a cross-rule ref arm's first-set
//    is resolved at fuse time; the nullable-prefix arm must be reachable.
// ---------------------------------------------------------------------------
describe('compose/fuse dispatch — nullable-prefix ref arm', () => {
  const makeFused = () => compose([rules(g => ({
    stmt: choice(g.interp, g.digits),
    interp: transform(sequence(optional(regex(/[.#]/)), regex(/@\{[a-z]+\}/)), x => x),
    digits: regex(/[0-9]+/),
  }))]) as Record<string, (i: string, p: number, c: Record<string, unknown>) => { ok: boolean; span: { end: number } }>

  it('fuse-resolved dispatch reaches the `@`-led ref arm', () => {
    // Exercises BOTH the fuse-time first-set substitution (ref arm → winning
    // rule's first-set) AND the nullable-prefix fix (interp includes `@`).
    // RED before the fix: interp's fused first-set omitted `@` → arm dropped.
    const g = makeFused()
    expect(g.stmt!('@{x}', 0, {}).ok).toBe(true)
    expect(g.stmt!('.@{y}', 0, {}).ok).toBe(true)
    expect(g.stmt!('42', 0, {}).ok).toBe(true)
  })
})
