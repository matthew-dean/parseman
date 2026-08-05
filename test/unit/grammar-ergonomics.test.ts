/**
 * The four grammar-authoring defects found by auditing parseman's own reference
 * grammars — each one had forced the showcase into a spelling parseman's own docs
 * then flag as wrong.
 *
 *   1. no positive lookahead → `not(not(X))`, an anti-pattern with first-set ANY
 *   2. `word()` could not express a case-insensitive keyword → `regex(/kw/i)`
 *   3. no non-empty separated list → `sepBy` unused 0 times in ~135 real lists
 *   4. the macro build's gating diagnostic reported no rule names, no anti-patterns
 *
 * Defects 1–3 are only half about ergonomics: each spelling parseman forced also
 * DESTROYED the arm's first-char dispatch, so every test below pairs the behaviour
 * with the gating consequence.
 */
import { describe, it, expect, vi } from 'vitest'
import { assertEnginesAgree } from '../parity/helpers/engine-parity.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import { isCompiledRule } from '../helpers/eval-macro-module.ts'
import {
  analyzeGating, choice, compile, diagnoseGrammar, keywords, literal, makeWord, many, not, oneOrMore,
  oneOrMoreSep, optional, parse, peek, regex, rules, sepBy, sequence, word,
  type Combinator, type ParserDef,
} from '../../src/index.ts'
import { node, runWithGrammarCoverage } from '../../src/index.ts'
import { matchesEmpty, firstSetOf } from '../../src/combinators/first-set.ts'
import { compileRuleMapTable as compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { compileLinkableTable as compileLinkable } from '../../src/compiler/compile-linkable-table.ts'
import { serializeRuleMap, evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'

/** Does this choice emit O(1) first-char dispatch? The single gating question. */
const dispatches = (c: Combinator<unknown>): boolean =>
  (c._def as Extract<ParserDef, { tag: 'choice' }>).disjoint

const firstChars = (c: Combinator<unknown>): string => {
  const fs = firstSetOf(c)
  if (fs.kind !== 'ranges') return fs.kind.toUpperCase()
  const out: string[] = []
  for (const r of fs.ranges) for (let i = r.lo; i <= r.hi; i++) out.push(String.fromCodePoint(i))
  return out.sort().join('')
}

/**
 * Run a combinator through BOTH engines — the interpreter and compiled output.
 *
 * Delegates the comparison to `assertEnginesAgree`, which compares the WHOLE
 * result object plus the context sinks. This used to compare `ok`, and then
 * `value`/`span.end` only when BOTH engines succeeded — so two engines could
 * fail the same input with different `expected` arrays and different
 * `span.start` and the helper stayed silent. That is precisely how the sepBy
 * `trailing: 'require'` payload divergence reached review. Do not re-narrow it
 * to a field checklist; see the header of `engine-parity.ts`.
 */
function bothEngines<T>(c: Combinator<T>, input: string): { ok: boolean; end: number; value: unknown } {
  const interpreted = assertEnginesAgree(c, input)
  return interpreted.ok
    ? { ok: true, end: interpreted.span.end, value: interpreted.value }
    : { ok: false, end: -1, value: undefined }
}

// ───────────────────────────────────────────────────────────────────────────
// Defect 1 — peek(): a positive lookahead that keeps its first-set
// ───────────────────────────────────────────────────────────────────────────

describe('defect 1 — peek() positive lookahead', () => {
  it('is zero-width: succeeds without consuming, fails when the body does not match', () => {
    const g = sequence(peek(literal('@')), regex(/@\w+/))
    expect(bothEngines(g, '@media')).toMatchObject({ ok: true, end: 6 })
    expect(bothEngines(g, '#media').ok).toBe(false)
    // Zero-width: the body's own span is not consumed by the lookahead.
    expect(bothEngines(peek(literal('@')), '@x')).toMatchObject({ ok: true, end: 0 })
  })

  // A lookahead exists precisely BECAUSE the term it guards is broad — a narrow
  // body would gate on its own. So the contrast has to use a broad body, which is
  // the shape `directMixinReferenceAhead` guards in the Less grammar (arm[0] of
  // `DirectLessValueAtom`'s 24-arm value dispatch).
  const broadBody = regex(/[^\s;{}]+/)

  it('GATING: an arm led by peek(regex(/[.#]/)) first-char-dispatches', () => {
    const viaAhead = sequence(peek(regex(/[.#]/)), broadBody)
    // The lookahead's chars are INTERSECTED into the sequence's first-set, so the
    // broad body no longer decides where the arm may start.
    expect(firstChars(viaAhead)).toBe('#.')
    const gated = choice(viaAhead, literal('@rule'), regex(/[0-9]+/))
    expect(dispatches(gated)).toBe(true)
    expect(bothEngines(gated, '.mixin()')).toMatchObject({ ok: true })
  })

  it('GATING: the not(not(X)) spelling it replaces poisons the same choice', () => {
    // `not()` cannot know what it forbids, so its own first-set is ANY…
    expect(firstChars(not(not(regex(/[.#]/))))).toBe('ANY')
    // …and being merely zero-width, it is SKIPPED rather than intersected, leaving
    // the broad body to decide the arm's first chars.
    const viaDoubleNot = sequence(not(not(regex(/[.#]/))), broadBody)
    expect(firstChars(viaDoubleNot)).not.toBe('#.')
    const ungated = choice(viaDoubleNot, literal('@rule'), regex(/[0-9]+/))
    expect(dispatches(ungated)).toBe(false)

    // …and the diagnostic names it, pointing at peek() as the fix.
    const report = analyzeGating(ungated)
    expect(report.antiPatterns.map(a => a.kind)).toContain('double-not')
    expect(report.antiPatterns.find(a => a.kind === 'double-not')!.message).toContain('peek(X)')
  })

  it('GATING: peek() also rescues a choice whose arms would otherwise OVERLAP', () => {
    // Two arms sharing a broad body: only the lookaheads tell them apart.
    const dotHash = sequence(peek(regex(/[.#]/)), broadBody)
    const atRule = sequence(peek(regex(/@/)), broadBody)
    expect(dispatches(choice(dotHash, atRule))).toBe(true)
    expect(dispatches(choice(
      sequence(not(not(regex(/[.#]/))), broadBody),
      sequence(not(not(regex(/@/))), broadBody),
    ))).toBe(false)
  })

  it('a NULLABLE body constrains no first char, so peek() reports ANY (sound)', () => {
    // `peek(optional-ish)` succeeds on the empty string — intersecting on its
    // body's chars would UNSOUNDLY exclude valid input.
    const nullableBody = regex(/[.#]*/)
    expect(firstChars(sequence(peek(nullableBody), regex(/[a-z]+/)))).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('the lookahead leaves no CST/trivia behind when it succeeds', () => {
    // `ahead` matches `@media`, then the real term consumes it — the text must
    // appear ONCE, not twice.
    const g = sequence(peek(regex(/@media/)), regex(/@\w+/))
    const r = parse(g, '@media')
    expect(r.ok && r.value).toEqual([null, '@media'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Defect 2 — word({ caseInsensitive })
// ───────────────────────────────────────────────────────────────────────────

describe('defect 2 — word() case-insensitive keywords', () => {
  it('matches either case, with the word boundary still applied', () => {
    const kw = word('media', 'A-Za-z0-9_-', { caseInsensitive: true })
    expect(bothEngines(kw, 'media')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(kw, 'MEDIA')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(kw, 'MeDiA')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(kw, 'mediaquery').ok).toBe(false)   // boundary still guards
  })

  it('the two-arg options form uses the default boundary', () => {
    const kw = word('true', { caseInsensitive: true })
    expect(bothEngines(kw, 'TRUE')).toMatchObject({ ok: true, end: 4 })
    expect(bothEngines(kw, 'TRUEISH').ok).toBe(false)
  })

  it('makeWord() carries explicit case-insensitive policy for a whole keyword family', () => {
    const cssWord = makeWord('A-Za-z0-9_-', { caseInsensitive: true })
    const media = cssWord('media')

    expect(bothEngines(media, 'MEDIA')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(media, 'mediaquery').ok).toBe(false)
  })

  it('makeWord() keeps the shared false default unless case-insensitive is requested', () => {
    const kw = makeWord('A-Za-z0-9_-')('media')

    expect(bothEngines(kw, 'media')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(kw, 'MEDIA').ok).toBe(false)
  })

  it('GATING: the first-set is ASCII case-FOLDED, so the arm still dispatches', () => {
    const kw = word('media', 'A-Za-z0-9_-', { caseInsensitive: true })
    expect(firstChars(kw)).toBe('Mm')
    const g = choice(sequence(literal('@'), kw), literal('#id'), regex(/[0-9]+/))
    expect(dispatches(g)).toBe(true)
  })

  it('agrees with the /i regex first-set fold that shipped in 0.32.0', () => {
    // Same keyword, both spellings — the folds must not disagree, or one of the
    // two gates is wrong.
    expect(firstChars(word('media', 'A-Za-z0-9_-', { caseInsensitive: true })))
      .toBe(firstChars(regex(/media(?![A-Za-z0-9_-])/i)))
  })

  it('case-insensitive matching is ASCII-only, matching the ASCII-only first-set', () => {
    // Under Unicode mode `/stroke/iu` ALSO matches `ſtroke` (U+017F folds to `s`),
    // which an ASCII-folded first-set would dispatch away from this arm — an
    // unsound gate. keywords() therefore does not enter Unicode mode.
    const kw = keywords(['stroke'], { caseInsensitive: true })
    expect(firstChars(kw)).toBe('Ss')
    expect(parse(kw, 'ſtroke').ok).toBe(false)
  })

  it('PARITY: the COMPILED build folds the same set — `ſtroke` is rejected there too', () => {
    // The 0.34.0 `iuy`→`iy` fix landed in the interpreter only; codegen kept
    // emitting `iuy`, so the compiled build (the artifact the macro ships) still
    // matched `ſtroke` while its ASCII first-set gated `ſ` away. A boundary is
    // what routes keywords() off the litFold fast path onto that regex.
    const kw = keywords(['stroke'], { caseInsensitive: true, boundary: 'A-Za-z0-9_-' })
    expect(bothEngines(kw, 'STROKE')).toMatchObject({ ok: true, end: 6 })
    expect(bothEngines(kw, 'ſtroke').ok).toBe(false)
  })

  it('PARITY: the compiled fast path declines a non-ASCII fold rather than mis-folding it', () => {
    // `litFold` folds ASCII letters only. Compiling `ärger` through it produced an
    // exact compare that missed `Ärger` — the compiled build silently REJECTED
    // input the interpreter accepted. Both spellings must agree, with and without
    // the boundary that routes the keyword off the fast path.
    expect(bothEngines(keywords(['ärger'], { caseInsensitive: true }), 'ÄRGER')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(keywords(['ärger'], { caseInsensitive: true, boundary: 'A-Za-z0-9_-' }), 'Ärger')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(keywords(['σtroke'], { caseInsensitive: true }), 'ςtroke')).toMatchObject({ ok: true, end: 6 })
  })

  it('GATING: a NON-ASCII case-insensitive keyword folds too, so its arm still dispatches', () => {
    // `/i` without `u` folds any pair that stays on ONE side of the ASCII boundary,
    // so `/(?:ärger)/iy` really does match `Ärger`. Widening the first-set only for
    // `cp < 128` left `Ä` out of it, and an enclosing choice then dispatched valid
    // input AWAY from the only arm that could match — the same gate/matcher
    // disagreement the `iu`→`iy` fix closed, left residual on the non-ASCII side.
    const kw = keywords(['ärger'], { caseInsensitive: true })
    expect(firstChars(kw)).toBe('Ää')
    expect(bothEngines(kw, 'Ärger')).toMatchObject({ ok: true, end: 5 })
    expect(bothEngines(kw, 'ärger')).toMatchObject({ ok: true, end: 5 })
    const g = choice(kw, literal('#id'))
    expect(dispatches(g)).toBe(true)
    expect(parse(g, 'Ärger').ok).toBe(true)   // false before the fix: gated away
  })

  it('GATING: a fold class WIDER than upper/lower (σ Σ ς) is still fully covered', () => {
    // Final sigma is in σ's fold class but is neither its uppercase nor its
    // lowercase, so widening by toUpperCase/toLowerCase alone would still gate
    // `ςtroke` away. 67 BMP code points sit in such classes.
    const kw = keywords(['σtroke'], { caseInsensitive: true })
    expect(firstChars(kw)).toBe('Σςσ')
    const g = choice(kw, literal('#id'))
    expect(dispatches(g)).toBe(true)
    for (const spelling of ['σtroke', 'Σtroke', 'ςtroke']) {
      expect(parse(kw, spelling).ok, spelling).toBe(true)     // the matcher accepts it
      expect(parse(g, spelling).ok, spelling).toBe(true)      // and the gate agrees
    }
  })

  it('the ASCII first-set is UNCHANGED by the non-ASCII fold (no dispatch precision lost)', () => {
    expect(firstChars(keywords(['media', 'supports'], { caseInsensitive: true }))).toBe('MSms')
    expect(firstChars(word('media', 'A-Za-z0-9_-', { caseInsensitive: true }))).toBe('Mm')
  })

  it('replaces the keyword-regex anti-pattern the diagnostic flags', () => {
    const viaRegex = choice(regex(/media/i), literal('#id'))
    expect(analyzeGating(viaRegex).antiPatterns.map(a => a.kind)).toContain('keyword-regex')
    const viaWord = choice(word('media', 'A-Za-z0-9_-', { caseInsensitive: true }), literal('#id'))
    expect(analyzeGating(viaWord).antiPatterns).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Defect 3 — the repeat family: { min, max, trailing } + oneOrMoreSep
// ───────────────────────────────────────────────────────────────────────────

describe('defect 3 — non-empty separated lists', () => {
  const item = regex(/[a-z]+/)
  const comma = literal(',')

  it('plain sepBy MATCHES THE EMPTY STRING — the defect, stated', () => {
    const r = parse(sepBy(item, comma), '')
    expect(r.ok).toBe(true)
    expect(r.ok && r.span).toEqual({ start: 0, end: 0 })
    expect(matchesEmpty(sepBy(item, comma))).toBe(true)
  })

  it('nullability generalizes past min 1 — a { min: N } list can never match empty', () => {
    // `matchesEmpty` keyed its sepBy case off `min === 1`, so EVERY `min >= 2`
    // list was reported nullable. Safe (it only over-widens a first-set) but
    // wrong, and it hung a bogus `nullable-prefix` note on the gating diagnostic
    // for a list that cannot match empty.
    for (const min of [1, 2, 5]) {
      expect(matchesEmpty(sepBy(item, comma, { min })), `min ${min}`).toBe(false)
    }
    expect(matchesEmpty(sepBy(item, comma, { min: 0 }))).toBe(true)
    // A nullable ITEM still makes the list nullable at any min — unchanged.
    expect(matchesEmpty(sepBy(optional(item), comma, { min: 2 }))).toBe(true)
    // …and the first-set of a min-2 list is the item's, not `any`.
    expect(firstChars(sepBy(item, comma, { min: 2 }))).toBe(firstChars(item))
    expect(bothEngines(sepBy(item, comma, { min: 2 }), '').ok).toBe(false)
    expect(bothEngines(sepBy(item, comma, { min: 2 }), 'a').ok).toBe(false)
    expect(bothEngines(sepBy(item, comma, { min: 2 }), 'a,b')).toMatchObject({ ok: true, end: 3 })
  })

  it('oneOrMoreSep is genuinely NON-NULLABLE and keeps the item first-set', () => {
    const list = oneOrMoreSep(item, comma)
    expect(matchesEmpty(list)).toBe(false)
    expect(firstChars(list)).toBe(firstChars(item))
    expect(bothEngines(list, '').ok).toBe(false)
    expect(bothEngines(list, 'a,b,c')).toMatchObject({ ok: true, end: 5, value: ['a', 'b', 'c'] })
  })

  it('oneOrMoreSep(i, s) IS sepBy(i, s, { min: 1 })', () => {
    const a = oneOrMoreSep(item, comma)._def as Extract<ParserDef, { tag: 'sepBy' }>
    const b = sepBy(item, comma, { min: 1 })._def as Extract<ParserDef, { tag: 'sepBy' }>
    expect(a.min).toBe(b.min)
    expect(a.min).toBe(1)
  })

  it('GATING: a nullable sepBy arm kills dispatch; oneOrMoreSep keeps it', () => {
    const ungated = choice(sequence(literal('('), sepBy(item, comma), literal(')')), literal('#id'))
    const gated = choice(sequence(literal('('), oneOrMoreSep(item, comma), literal(')')), literal('#id'))
    // Both sequences lead with '(' so the SEQUENCE gates either way; the real
    // difference shows when the list leads the arm.
    expect(dispatches(ungated)).toBe(true)
    expect(dispatches(gated)).toBe(true)

    const listLedNullable = choice(sepBy(item, comma), literal('#id'), literal('@x'))
    const listLedNonEmpty = choice(oneOrMoreSep(item, comma), literal('#id'), literal('@x'))
    expect(dispatches(listLedNullable)).toBe(false)   // nullable arm ⇒ no dispatch
    expect(dispatches(listLedNonEmpty)).toBe(true)
  })

  it('many/oneOrMore take the same { min, max }, and min >= 1 is non-nullable', () => {
    expect(matchesEmpty(many(item))).toBe(true)
    expect(matchesEmpty(many(item, { min: 1 }))).toBe(false)
    expect(matchesEmpty(oneOrMore(item))).toBe(false)
    // `max` never affects nullability.
    expect(matchesEmpty(many(item, { max: 3 }))).toBe(true)
    expect(matchesEmpty(many(item, { min: 2, max: 3 }))).toBe(false)
  })

  it('oneOrMore(x) IS many(x, { min: 1 }) — the same def, not a lookalike', () => {
    const a = oneOrMore(item)._def as Extract<ParserDef, { tag: 'oneOrMore' }>
    const b = many(item, { min: 1 })._def as Extract<ParserDef, { tag: 'oneOrMore' }>
    expect(a.tag).toBe(b.tag)
    expect(a.min).toBe(b.min)
  })

  it('max bounds the item count on both engines', () => {
    const two = sepBy(item, comma, { max: 2 })
    expect(bothEngines(two, 'a,b,c')).toMatchObject({ ok: true, value: ['a', 'b'] })
    const upTo3 = many(regex(/x/), { max: 3 })
    expect(bothEngines(upTo3, 'xxxxx')).toMatchObject({ ok: true, end: 3 })
  })

  it('min > 1 requires that many items on both engines', () => {
    const three = many(regex(/x/), { min: 3 })
    expect(bothEngines(three, 'xxxx')).toMatchObject({ ok: true, end: 4 })
    expect(bothEngines(three, 'xx').ok).toBe(false)
    const threeSep = sepBy(item, comma, { min: 3 })
    expect(bothEngines(threeSep, 'a,b,c')).toMatchObject({ ok: true, value: ['a', 'b', 'c'] })
    expect(bothEngines(threeSep, 'a,b').ok).toBe(false)
  })

  it("trailing: 'forbid' (the default) leaves the separator for the enclosing rule", () => {
    expect(bothEngines(sepBy(item, comma), 'a,b,')).toMatchObject({ ok: true, end: 3, value: ['a', 'b'] })
  })

  it("trailing: 'allow' consumes a trailing separator", () => {
    const list = sepBy(item, comma, { trailing: 'allow' })
    expect(bothEngines(list, 'a,b,')).toMatchObject({ ok: true, end: 4, value: ['a', 'b'] })
    expect(bothEngines(list, 'a,b')).toMatchObject({ ok: true, end: 3, value: ['a', 'b'] })
  })

  // A list where EVERY item is followed by the separator is not a separated list
  // at all — n separators for n items, not n-1. That is a TERMINATED list, and the
  // existing combinators already spell it: `many(sequence(item, term))`. `sepBy`
  // deliberately has no `trailing: 'require'` mode for it. Carrying one meant a
  // loop-scoped `sawTrailing` flag, a `_trl` flag in the emitted source and a
  // bespoke failure payload — machinery for a `many` with a fixed element shape,
  // and the source of two of this branch's three parity divergences.
  it('a TERMINATED list is many(sequence(item, term)), not a sepBy mode', () => {
    const terminated = many(sequence(item, literal(';')))
    expect(bothEngines(terminated, 'a;b;')).toMatchObject({ ok: true, end: 4 })
    // The distinguishing case: a final item with no terminator is not part of the
    // list, so the list ends before it rather than failing the whole parse.
    expect(bothEngines(terminated, 'a;b;c')).toMatchObject({ ok: true, end: 4 })
    expect(bothEngines(terminated, '')).toMatchObject({ ok: true, end: 0, value: [] })
  })

  it('rejects bounds that could never succeed, at CONSTRUCTION', () => {
    expect(() => many(item, { min: 3, max: 2 })).toThrow(/max \(2\) is less than min \(3\)/)
    expect(() => many(item, { min: -1 })).toThrow(/non-negative integer/)
    expect(() => sepBy(item, comma, { max: 0 })).toThrow(/positive integer/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Defect 4 — the gating diagnostic over a rule-map grammar
//
// These used to assert that `compileRuleMap`/`compile` PRINTED the findings. They
// no longer print anything: producing an artifact and reporting on it are separate
// acts, and `diagnoseGrammar` is the second one. What the defect was really about —
// that a rule-map grammar is analysed at all, and that findings NAME the owning rule
// instead of `<entry>` — is unchanged and still asserted, now through that entry
// point plus a pinned assertion that the compile path stays silent.
// ───────────────────────────────────────────────────────────────────────────

describe('defect 4 — the rule-map diagnostic reports rule names AND anti-patterns', () => {
  /** A rule map with one genuinely-ungated choice and one keyword-regex arm. */
  const grammar = () => rules(g => ({
    Value: choice(literal('a'), regex(/[\s\S]*/)),
    AtRule: choice(regex(/media/), literal('#x')),
    Entry: sequence(g.Value as Combinator<unknown>, g.AtRule as Combinator<unknown>),
  }))

  const warningsFrom = (run: () => void): string[] => {
    const seen: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { seen.push(String(m)) })
    try { run() } finally { spy.mockRestore() }
    return seen
  }

  it('compileRuleMap prints NOTHING — compiling is not reporting', () => {
    expect(warningsFrom(() => { compileRuleMap(Object.entries(grammar())) })).toEqual([])
  })

  it('diagnoseGrammar analyses a rule-map grammar and NAMES the owning rule', () => {
    // Before: the analysis was never run over a rule map at all, so a macro-built
    // grammar produced ZERO findings however many ungated choices it had.
    const d = diagnoseGrammar(grammar())
    expect(d.ok).toBe(false)
    expect(d.findings.map(f => f.id)).toContain('Value')
    expect(d.findings.map(f => f.id)).not.toContain('<entry>')
  })

  it('diagnoseGrammar reports ANTI-PATTERNS, named by rule', () => {
    const d = diagnoseGrammar(grammar())
    const ap = d.findings.find(f => f.code === 'anti-pattern' && f.rule === 'AtRule')
    expect(ap).toBeDefined()
    expect(ap!.message).toContain('keyword-regex')
  })

  it('analyzeGatingRules attributes each choice to the rule that owns it', () => {
    const report = analyzeGating(rules(g => ({
      Outer: choice(literal('a'), regex(/[\s\S]*/)),
      Inner: choice(regex(/media/), literal('#x')),
      Entry: sequence(g.Outer as Combinator<unknown>, g.Inner as Combinator<unknown>),
    })).Entry as Combinator<unknown>)
    // Reached from a single entry, the walk still recovers both rule names.
    expect(report.choices.map(c => c.id).sort()).toEqual(['Inner', 'Outer'])
    expect(report.antiPatterns.map(a => a.rule)).toContain('Inner')
  })

  it('a single-combinator diagnosis is attributed to its BINDING name, not <entry>', () => {
    // `entryName` names the const the finding belongs to — without it every top-level
    // combinator reports as `<entry>`, which names nothing and gives the `accept`
    // allowlist no discriminating key.
    const g = choice(literal('a'), regex(/[\s\S]*/))
    expect(analyzeGating(g).choices[0]!.id).toBe('<entry>')
    expect(analyzeGating(g, { entryName: 'directMixinReferenceAhead' }).choices[0]!.id)
      .toBe('directMixinReferenceAhead')

    expect(warningsFrom(() => { compile(g, undefined) })).toEqual([])
    expect(diagnoseGrammar(g, { entryName: 'directMixinReferenceAhead' }).findings[0]!.id)
      .toBe('directMixinReferenceAhead')
  })

  it('the named id is a usable accept key (which `<entry>` was not)', () => {
    const g = choice(literal('a'), regex(/[\s\S]*/))
    const r = analyzeGating(g, { entryName: 'valueAtom', accept: ['valueAtom'] })
    expect(r.ungated).toHaveLength(0)
    expect(r.accepted.map(c => c.id)).toEqual(['valueAtom'])
    expect(r.acceptedUnused).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Every engine must agree: interpreter, compiled, MACRO, carried IR, coverage
// ───────────────────────────────────────────────────────────────────────────

describe('the new API survives every lowering path', () => {
  const MACRO = `import { rules, sequence, choice, literal, regex, peek, many, oneOrMore, sepBy, oneOrMoreSep } from 'parseman' with { type: 'macro' }
export const g = rules(g => ({
  Entry: choice(g.Mixin, g.List),
  Mixin: sequence(peek(regex(/[.#]/)), regex(/[.#][a-z-]+/)),
  List: sequence(literal('('), oneOrMoreSep(regex(/[a-z]+/), literal(',')), literal(')')),
  Bounded: many(regex(/x/), { min: 2, max: 4 }),
  Trailing: sepBy(regex(/[a-z]+/), literal(';'), { trailing: 'allow' }),
  Plus: oneOrMore(regex(/y/)),
}))`

  it('macro-compiles peek / oneOrMoreSep / { min, max } / { trailing } statically', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const out = transformMacro(MACRO, 'ergonomics-macro.ts', new Set(['parseman']))
    expect(out).not.toBeNull()
    // A silent interpreter fallback would warn and leave the call interpreted;
    // a static compile emits a `_r_<Name>` function per rule.
    expect(out!.warnings).toEqual([])
    expect(isCompiledRule(out!.code, 'Mixin'), out!.code).toBe(true)
    // The exported grammar CARRIES its IR for downstream composition — every option
    // must survive that round trip or a composed dialect silently loses it.
    expect(out!.code).toContain('peek(regex(')
    expect(out!.code).toContain('{ min: 1 }')
    expect(out!.code).toContain('{ min: 2, max: 4 }')
    expect(out!.code).toContain('trailing: \\"allow\\"')
    const g = evalMacroModule<Record<
      string, (input: string, pos: number, ctx: unknown) => { ok: boolean; value?: unknown; span?: { end: number } }
    >>(out!.code, 'g')
    const run = (rule: string, input: string) => g[rule]!(input, 0, { trackLines: false })

    expect(run('Mixin', '.rounded').ok).toBe(true)
    expect(run('Mixin', 'rounded').ok).toBe(false)
    expect(run('List', '(a,b)').ok).toBe(true)
    expect(run('List', '()').ok).toBe(false)          // oneOrMoreSep is non-empty
    expect(run('Bounded', 'x').ok).toBe(false)         // min 2
    expect(run('Bounded', 'xxxxxx').span!.end).toBe(4) // max 4
    expect(run('Trailing', 'a;b;').span!.end).toBe(4)  // trailing consumed
    expect(run('Plus', '').ok).toBe(false)
  })

  it('round-trips through the carried IR with its options intact', () => {
    const g = rules(() => ({
      Mixin: sequence(peek(regex(/[.#]/)), regex(/[.#][a-z-]+/)),
      List: oneOrMoreSep(regex(/[a-z]+/), literal(',')),
      Bounded: many(regex(/x/), { min: 2, max: 4 }),
      Trailing: sepBy(regex(/[a-z]+/), literal(';'), { trailing: 'allow' }),
    }))
    const ir = serializeRuleMap(Object.entries(g))
    expect(ir).not.toBeNull()
    expect(ir!).toContain('peek(')
    expect(ir!).toContain('{ min: 2, max: 4 }')
    expect(ir!).toContain(`trailing: "allow"`)

    const back = Object.fromEntries(evalRuleMapIR(ir!))
    expect(parse(back.Mixin!, '.a').ok).toBe(true)
    expect(parse(back.Mixin!, 'a').ok).toBe(false)
    expect(parse(back.List!, '').ok).toBe(false)
    expect(parse(back.Bounded!, 'x').ok).toBe(false)
    // `trailing: 'allow'` survived the round-trip iff the trailing separator is
    // CONSUMED — the span, not merely `ok`, is what distinguishes it from the
    // 'forbid' default (which would stop at 3 and leave the ';' to the caller).
    const noTrail = parse(back.Trailing!, 'a;b')
    expect(noTrail.ok && noTrail.span.end).toBe(3)
    const withTrail = parse(back.Trailing!, 'a;b;')
    expect(withTrail.ok && withTrail.span.end).toBe(4)
  })

  it('the coverage-instrumented rebuild preserves peek and the repeat bounds', () => {
    const entry = sequence(peek(regex(/[.#]/)), regex(/[.#][a-z]+/), many(regex(/x/), { max: 2 }))
    expect(runWithGrammarCoverage(entry, '.abxxx').result.ok).toBe(true)
    expect(runWithGrammarCoverage(entry, 'ab').result.ok).toBe(false)
    const bounded = runWithGrammarCoverage(oneOrMoreSep(regex(/[a-z]+/), literal(',')), '')
    expect(bounded.result.ok).toBe(false)
  })

  it('trailing separators unwind CST capture correctly under a node()', () => {
    // The capturing+trivia branch of emitSepBy takes its own post-separator marks;
    // a leaked capture would show up as an extra child.
    const List = node('List', sepBy(regex(/[a-z]+/), literal(','), { trailing: 'allow' }),
      children => children.length)
    // 2 children — `a` and `b`. A list contributes its items and nothing else, so
    // NO separator is a child, not even the trailing one that `trailing: 'allow'`
    // consumes. The two inputs are distinguished by `end`, not by child count:
    // 'a,b,' consumes 4 chars (the trailing comma IS eaten) while 'a,b' consumes 3.
    // That pair is the check that the demote runs BEFORE the post-separator marks
    // are sampled — sample first and the 'allow' unwind restores the separator
    // into `children` on exactly this path.
    expect(bothEngines(List, 'a,b,')).toMatchObject({ ok: true, end: 4, value: 2 })
    expect(bothEngines(List, 'a,b')).toMatchObject({ ok: true, end: 3, value: 2 })
  })

  it('compileLinkable never reports — and the same map still diagnoses', () => {
    const map: Array<[string, Combinator<unknown>]> = [['Value', choice(literal('a'), regex(/[\s\S]*/))]]
    const seen: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { seen.push(String(m)) })
    try {
      compileLinkable(map, 'ns1')
      compileLinkable(map, 'ns2')
      expect(seen).toEqual([])
    } finally { spy.mockRestore() }
    expect(diagnoseGrammar(map).findings.map(f => f.id)).toContain('Value')
  })
})
