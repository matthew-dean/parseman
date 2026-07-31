/**
 * balanced(open, close, { strict: true }) — make an unmatched close a real FAILURE.
 *
 * THE DEFECT
 * ----------
 * `balanced()` wraps its close in `expect()`, and `expect()` never fails: on a
 * miss it returns a ParseError, pushes it onto `ctx._errors`, and reports a
 * zero-width span. So `balanced()` is UNFAILABLE once its opener is consumed.
 * The rejection is already computed and recorded — but no caller can branch on
 * it. `choice()` cannot fall through to another arm, `not()` cannot negate it,
 * and an enclosing `sequence()` carries on as though the group had closed.
 *
 * `strict: true` requires the close instead, so the group fails and rolls back
 * to the opener.
 *
 * WHAT STRICT MODE IS *NOT*
 * -------------------------
 * It does NOT change what counts as balanced. `balanced('(', ')')` tracks ONE
 * pair; a delimiter belonging to any other pair is ordinary content, by design.
 * `([c}])` is therefore well-formed to it — and MUST stay that way, because the
 * css grammar accepts `var(--x, ([c}]))` and depends on that acceptance. Strict
 * mode changes failure behaviour only, never the accepted language. The tests
 * below pin both halves of that claim.
 */
import { describe, it, expect as vexpect } from 'vitest'
import { balanced, regex, sequence, literal, choice, not, rules, run } from '../../src/index.ts'
import type { ParseError } from '../../src/types.ts'

const tolerant = balanced('(', ')')
const strict = balanced('(', ')', { strict: true })

/** Run a bare combinator directly, so we see ok/span/errors without a grammar. */
function go(c: ReturnType<typeof balanced>, src: string) {
  const errors: ParseError[] = []
  const r = c.parse(src, 0, { trackLines: false, state: {}, _errors: errors })
  return { ok: r.ok, end: r.span.end, value: r.ok ? r.value : undefined, errors: errors.length }
}

describe('the accepted language is identical', () => {
  it.each([
    '(a)', '((a))', '(a b c)', '()',
    '([c}])',        // the css `var(--x, ([c}]))` shape — foreign delimiters are CONTENT
    '([a])', '({a})', '([a)]', '(}{)', '(][)',
  ])('strict and tolerant accept %j identically', src => {
    const t = go(tolerant, src)
    const s = go(strict, src)
    vexpect(s.ok).toBe(true)
    vexpect({ ok: s.ok, end: s.end, value: s.value }).toEqual({ ok: t.ok, end: t.end, value: t.value })
  })

  it('foreign delimiters stay content — var(--x, ([c}])) must keep parsing', () => {
    // Pinned explicitly: this is the case a "crossed nesting" reading would break.
    for (const c of [tolerant, strict]) {
      const r = go(c, '([c}])')
      vexpect(r).toMatchObject({ ok: true, end: 6, value: '([c}])', errors: 0 })
    }
  })
})

describe('strict turns a recovered close into a failure', () => {
  it.each(['(a', '(', '(a b', '((a)', '(a ('])('rejects unclosed %j', src => {
    vexpect(go(tolerant, src).ok).toBe(true)        // recovered — the defect
    vexpect(go(strict, src).ok).toBe(false)         // failed — the fix
  })

  it('tolerant records the very error strict fails on', () => {
    // The information was always there; only the failure was missing.
    const t = go(tolerant, '(a')
    vexpect(t).toMatchObject({ ok: true, errors: 1 })
    vexpect(go(strict, '(a').ok).toBe(false)
  })

  it('reports the close it wanted', () => {
    const r = strict.parse('(a', 0, { trackLines: false, state: {} })
    vexpect(r.ok).toBe(false)
    if (!r.ok) vexpect(r.expected).toContain('")"')
  })
})

describe('rollback', () => {
  it('consumes nothing when it fails', () => {
    // A failed parse returns ok:false (its span marks WHERE it failed, which is
    // parseman's convention, not a consumed extent). Rollback is observable from
    // the caller: a sibling arm resumes at the original position.
    const r = strict.parse('(a', 0, { trackLines: false, state: {} })
    vexpect(r.ok).toBe(false)
    const fell = choice(strict, literal('(')).parse('(a', 0, { trackLines: false, state: {} })
    vexpect(fell).toMatchObject({ ok: true, value: '(', span: { start: 0, end: 1 } })
  })

  it('does not fire when the opener is absent', () => {
    for (const src of ['a)', '', ' (a)']) vexpect(go(strict, src).ok).toBe(false)
  })

  it('leaves trailing input unconsumed', () => {
    vexpect(go(strict, '(a)(b)')).toMatchObject({ ok: true, end: 3, value: '(a)' })
  })

  it('nested groups inherit strictness', () => {
    // Inner group unclosed: the interior recurses through the SAME combinator.
    vexpect(go(strict, '((a)').ok).toBe(false)
    vexpect(go(strict, '((a))').ok).toBe(true)
  })
})

describe('strict makes the rejection usable by other combinators', () => {
  it('lets choice() fall through to another arm', () => {
    const fallback = regex(/\(\w+/)
    const tolerantChoice = choice(tolerant, fallback)
    const strictChoice = choice(strict, fallback)
    // Tolerant: the balanced arm "succeeds" on '(a', so the fallback is dead code.
    vexpect(go(tolerantChoice, '(a')).toMatchObject({ ok: true, value: '(a' })
    // Strict: the arm fails, so the fallback actually gets its turn.
    const s = strictChoice.parse('(a', 0, { trackLines: false, state: {} })
    vexpect(s.ok).toBe(true)
  })

  it('lets not() negate an unclosed group', () => {
    // not(tolerant) can NEVER succeed past an opener — tolerant always matches.
    vexpect(not(tolerant).parse('(a', 0, { trackLines: false, state: {} }).ok).toBe(false)
    vexpect(not(strict).parse('(a', 0, { trackLines: false, state: {} }).ok).toBe(true)
    // A well-formed group is still negated by both.
    vexpect(not(strict).parse('(a)', 0, { trackLines: false, state: {} }).ok).toBe(false)
  })

  it('lets an enclosing sequence reject the whole construct', () => {
    const seq = (b: ReturnType<typeof balanced>) => sequence(literal('f'), b, literal(';'))
    vexpect(seq(strict).parse('f(a);', 0, { trackLines: false, state: {} }).ok).toBe(true)
    vexpect(seq(strict).parse('f(a;', 0, { trackLines: false, state: {} }).ok).toBe(false)
    // The contrast with tolerant is that its group SUCCEEDS on the unclosed
    // input, so the rejection never reaches the sequence at all — the enclosing
    // parse fails (or not) for unrelated reasons downstream.
    vexpect(go(tolerant, '(a;')).toMatchObject({ ok: true, value: '(a;' })
    vexpect(go(strict, '(a;').ok).toBe(false)
  })
})

describe('strict composes with skips, trivia and ambient scanSkip', () => {
  const singleStr = sequence(literal("'"), regex(/[^']*/), literal("'"))
  const blockComment = sequence(literal('/*'), regex(/(?:[^*]|\*(?!\/))*/), literal('*/'))

  it('honours per-call skip', () => {
    const s = balanced('(', ')', { strict: true, skip: [singleStr, blockComment] })
    vexpect(go(s, "(a ')' b)")).toMatchObject({ ok: true, value: "(a ')' b)" })
    vexpect(go(s, '(a /* ) */ b)')).toMatchObject({ ok: true })
    // A close hidden in a string does NOT satisfy the strict close.
    vexpect(go(s, "(a ')'").ok).toBe(false)
  })

  it('spans whitespace and newlines', () => {
    vexpect(go(strict, '(\n  a\n)')).toMatchObject({ ok: true })
  })

  it('keeps the same first-set gating as tolerant', () => {
    vexpect(strict._meta.firstSet).toEqual(tolerant._meta.firstSet)
  })

  it('re-resolves ambient scanSkip while STAYING strict', () => {
    // The ambient rebuild path must carry `strict` through, or a grammar that
    // declares scanSkip would silently get the recovering interior back.
    const g = rules({ scanSkip: [singleStr] }, () => ({
      E: balanced('(', ')', { strict: true }),
    }))
    vexpect(run(g.E, "(a ')' b)").value).toBe("(a ')' b)")   // ambient skip honoured
    vexpect(run(g.E, "(a ')' b").ok).toBe(false)             // and still strict
  })

  it('raw: true still supports strict', () => {
    const s = balanced('(', ')', { strict: true, raw: true })
    vexpect(go(s, '(a)')).toMatchObject({ ok: true })
    vexpect(go(s, '(a').ok).toBe(false)
  })
})

describe('default is unchanged', () => {
  it('omitting strict, and passing strict: false, both recover', () => {
    vexpect(go(balanced('(', ')'), '(a').ok).toBe(true)
    vexpect(go(balanced('(', ')', { strict: false }), '(a').ok).toBe(true)
  })
})
