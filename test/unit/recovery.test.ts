/**
 * Layered "C+B" list recovery.
 *
 *   C — the sync point is inferred for free from the immediate enclosing combinator:
 *       a `sepBy` knows its separator, and a list inside `sequence(open, …, close)`
 *       learns `close` (the sequence publishes its following-terms' first set as the
 *       sync point while parsing each term).
 *   B — an explicit `{ recover }` hint on `many`/`oneOrMore`/`sepBy` supplies sync
 *       where it isn't local, or overrides the inferred sync for a tighter error.
 *
 * Recovery is gated on the run-level `tolerant` flag; the strict default never runs
 * any of it.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, oneOrMore, many, sepBy, optional,
  run, parse, completionsAt, isParseError, trivia, rules,
} from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'

// ── Compact (trivia-free) grammar: `{ a:1 ; b:2 }`-ish declaration blocks ──────
const ident = regex(/[a-z]+/)
const num = regex(/[0-9]+/)
const decl = sequence(ident, literal(':'), num)
const declList = sepBy(decl, literal(';'))
const block = sequence(literal('{'), declList, literal('}'))

const countErrors = (v: unknown): number =>
  Array.isArray(v) ? v.filter(isParseError).length : 0
const errorsIn = (v: unknown) =>
  Array.isArray(v) ? v.filter(isParseError) : []

describe('C — local structural inference (no annotation)', () => {
  it('a list inside a block resyncs to the enclosing close', () => {
    // `$$` is junk; the inner sepBy has no hint — it infers `}` from the block
    // sequence and `;` from its own separator, so it recovers and keeps parsing.
    const r = run(block as Combinator<unknown>, '{a:1;$$;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null) // the closing `}` was still reached
    const list = (r.value as unknown[])[1]
    expect(countErrors(list)).toBe(1)
    expect((list as unknown[]).length).toBe(3) // [decl, error, decl]
    expect(r.errors).toHaveLength(1)
  })

  it('recovers a bad final element up to the close (no trailing separator)', () => {
    const r = run(block as Combinator<unknown>, '{a:1;$$}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
    const list = (r.value as unknown[])[1]
    expect(countErrors(list)).toBe(1)
    const [err] = errorsIn(list)
    expect(err!.span).toEqual({ start: 5, end: 7 }) // `$$` skipped, `}` not consumed
  })

  it('recovers a bad FIRST element', () => {
    const r = run(block as Combinator<unknown>, '{$$;a:1}', { tolerant: true })
    expect(r.ok).toBe(true)
    const list = (r.value as unknown[])[1]
    expect(countErrors(list)).toBe(1)
    expect((list as unknown[]).length).toBe(2) // [error, decl]
  })

  it('a trailing separator before the close is NOT junk (no spurious error)', () => {
    // `{a:1;}` — the `;` is a legal empty trailing element; sepBy stops cleanly.
    const declListOpt = sequence(literal('{'), sepBy(decl, literal(';')), literal(';'), literal('}'))
    const r = run(declListOpt as Combinator<unknown>, '{a:1;}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('a bare list with no enclosing delimiter and no hint cannot recover', () => {
    // No sequence around it ⇒ no inferred sync, no hint ⇒ tolerant falls back to
    // strict: the list stops at the first bad element. (A flag alone can't recover.)
    const r = run(declList as Combinator<unknown>, 'a:1;$$;b:2', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
    expect((r.value as unknown[]).length).toBe(1) // just [decl a:1]
  })
})

describe('B — hint override', () => {
  it('a hint supplies sync at a non-local (top-level) site', () => {
    const list = sepBy(decl, literal(';'), { recover: literal('%') })
    const r = run(list as Combinator<unknown>, 'a:1;$$;b:2%', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(countErrors(r.value)).toBe(1)
    expect((r.value as unknown[]).length).toBe(3) // [decl, error, decl]
  })

  it('a hint overrides the inferred sync for a better error tree', () => {
    // `sequence('{', sepBy(num, ','), optional('#'), '}')`. Layer C infers the sync
    // from ALL following terms, so it includes the optional `#` — a stray `#` inside
    // the junk stops recovery early and the outer `}` is then missed. A `{ recover: }`
    // hint of just `}` overrides that: recovery ignores the stray `#` and resyncs to
    // the real close, so the parse completes. Same site, hint wins.
    const inferredList = sequence(literal('{'), sepBy(num, literal(',')), optional(literal('#')), literal('}'))
    const hintedList = sequence(
      literal('{'),
      sepBy(num, literal(','), { recover: literal('}') }),
      optional(literal('#')),
      literal('}'),
    )
    const inferred = run(inferredList as Combinator<unknown>, '{@#@}', { tolerant: true })
    const hinted = run(hintedList as Combinator<unknown>, '{@#@}', { tolerant: true })

    // Inference stopped at the stray `#` → the outer sequence can't finish.
    expect(inferred.ok).toBe(false)
    // The hint skipped straight to `}` → clean recovery over the whole `@#@` junk.
    expect(hinted.ok).toBe(true)
    const [err] = hinted.errors
    expect(err!.span).toEqual({ start: 1, end: 4 })
  })
})

describe('gating — strict is untouched, recovery only in tolerant', () => {
  it('strict mode stops the list at the first bad element (no errors)', () => {
    const r = run(block as Combinator<unknown>, '{a:1;$$;b:2}') // no tolerant
    // The bad `$$` makes the whole block fail (sepBy stops, `}` not found).
    expect(r.ok).toBe(false)
    expect(r.errors).toHaveLength(0)
  })

  it('strict mode on valid input is unaffected', () => {
    const r = run(block as Combinator<unknown>, '{a:1;b:2}')
    expect(r.ok).toBe(true)
    expect(countErrors((r.value as unknown[])[1])).toBe(0)
  })

  it('tolerant mode on valid input produces no errors (recovery never runs)', () => {
    const r = run(block as Combinator<unknown>, '{a:1;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
    expect(countErrors((r.value as unknown[])[1])).toBe(0)
  })
})

describe('error-node emission', () => {
  it('emits a ParseError node spanning the skipped junk, with an expected set', () => {
    const r = run(block as Combinator<unknown>, '{a:1;###;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    const [err] = r.errors
    expect(err!._tag).toBe('parseError')
    expect(err!.span).toEqual({ start: 5, end: 8 }) // `###`
    expect(err!.expected.length).toBeGreaterThan(0) // what a decl wanted
    // The same node is in the value tree AND the side-channel.
    expect(isParseError(errorsIn((r.value as unknown[])[1])[0])).toBe(true)
  })
})

describe('loop guard — a zero-width failure can never spin', () => {
  it('missing element between two separators yields a zero-width error, not a hang', () => {
    const r = run(block as Combinator<unknown>, '{a:1;;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    const list = (r.value as unknown[])[1]
    expect(countErrors(list)).toBe(1)
    const [err] = errorsIn(list)
    expect(err!.span).toEqual({ start: 5, end: 5 }) // zero-width, between the two `;`
  })

  it('many with the sync token immediately present ends cleanly (no error, no spin)', () => {
    // Inner list empty, close right after open: recovery must not fire.
    const r = run(block as Combinator<unknown>, '{}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0)
    expect((r.value as unknown[])[1]).toEqual([])
  })
})

describe('completionsAt — recovery records the cursor failure', () => {
  // A top-level declaration list with a `;` recovery hint, so a permissive rule
  // would otherwise "succeed" with an unconsumed tail and record nothing.
  const declH = sequence(ident, literal(':'), oneOrMore(num))
  const sheet = many(declH, { recover: literal(';') })

  it('strict: an incomplete value at the cursor yields NO completions (the gap)', () => {
    expect(completionsAt(sheet as Combinator<unknown>, 'a:', 2)).toEqual([])
  })

  it('tolerant: value position returns the number pattern', () => {
    const c = completionsAt(sheet as Combinator<unknown>, 'a:', 2, { tolerant: true })
    expect(c).toContain('/[0-9]+/')
  })

  it('tolerant: property-name position returns the identifier pattern', () => {
    // `a:1;9` — a digit where the next property name should start.
    const c = completionsAt(sheet as Combinator<unknown>, 'a:1;9', 5, { tolerant: true })
    expect(c).toContain('/[a-z]+/')
  })

  it('tolerant: a fully valid prefix still returns no completions', () => {
    expect(completionsAt(sheet as Combinator<unknown>, 'a:1', 3, { tolerant: true })).toEqual([])
  })
})

// ── Tolerant sequences over ambient trivia (parseTolerant, sequence.ts) ────────
// The compact grammars above are trivia-free, so the tolerant sequence's
// between-terms trivia branch (`ctx.trivia && i > 0`) never runs. A real grammar
// declares ambient trivia via `rules({ trivia })`; run tolerantly, its sequences
// skip trivia around every term while publishing layer-C sync sentinels.
const tws = trivia(oneOrMore(regex(/[ \t\n]+/)))
const tgram = rules({ trivia: tws }, () => ({
  triple: sequence(ident, literal(':'), num),           // 3 terms, trivia between
  trailingOpt: sequence(ident, optional(literal('!'))), // optional tail → empty match after trivia
}))

describe('tolerant sequences over ambient trivia (parseTolerant)', () => {
  it('skips ambient trivia between terms on the tolerant path (deferred-commit)', () => {
    // run() always sets ctx._triviaLog, so needsDeferredTriviaCommit is true and
    // the scan+commit branch is exercised.
    const r = run(tgram.triple as Combinator<unknown>, 'a  :\t1', { tolerant: true, trivia: tws })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
    expect(r.value).toEqual(['a', ':', '1'])
  })

  it('propagates a term failure after trivia (tolerant == strict on well-formed prefixes)', () => {
    const r = run(tgram.triple as Combinator<unknown>, 'a : x', { tolerant: true, trivia: tws })
    expect(r.ok).toBe(false)
  })

  it('rolls back scanned trivia when a post-trivia term consumes nothing', () => {
    // The trailing optional matches empty at the post-space position, so the space
    // must be rolled back (not folded into the sequence span / trivia attribution).
    const r = run(tgram.trailingOpt as Combinator<unknown>, 'a  ', { tolerant: true, trivia: tws })
    expect(r.ok).toBe(true)
    expect(r.value).toEqual(['a', null])
    expect(r.unconsumedFrom).toBe(null) // trailing space skipped by run()'s trivia
  })

  it('takes the immediate advanceTrivia branch when no trivia/CST log is active', () => {
    // Direct parse() with a minimal ctx (no _triviaLog/_cstBuf/_cstTriviaLog) makes
    // needsDeferredTriviaCommit false → the non-deferred advanceTrivia path.
    const ctx = { trackLines: false, trivia: tws, _tolerant: true } as unknown as ParseContext
    const r = tgram.triple.parse('a : 1', 0, ctx)
    expect(r.ok).toBe(true)
    expect(r.ok && r.value).toEqual(['a', ':', '1'])
  })
})

describe('oneOrMore tolerant recovery (repeat.ts cold path)', () => {
  // Existing recovery tests exercise sepBy/many; oneOrMore's tolerant resync loop
  // (an element that STARTS then fails partway) needs its own coverage.
  const fenced = sequence(oneOrMore(decl), literal('%'))

  it('resyncs over an element that starts then fails, up to the enclosing sync', () => {
    // `b:` begins a decl (ident + `:`) but the number is missing → partial fail →
    // recover to the sequence's `%` sync, emit one error, finish the parse.
    const r = run(fenced as Combinator<unknown>, 'a:1b:%', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(1)
    const list = (r.value as unknown[])[0] as unknown[]
    expect(countErrors(list)).toBe(1)
    expect(list.length).toBe(2) // [decl a:1, error]
  })

  it('strict oneOrMore still fails hard on the same input (recovery is tolerant-only)', () => {
    expect(run(fenced as Combinator<unknown>, 'a:1b:%').ok).toBe(false)
  })
})

describe('run() over a trivia-clearing grammar (rules({ trivia: null }))', () => {
  // Regression: run() read `grammarTrivia._meta` whenever grammarTrivia !== undefined,
  // but `rules({ trivia: null })` makes it null → a crash. `!= null` now skips it.
  const cleared = rules({ trivia: null }, () => ({ pair: sequence(ident, literal(':'), num) }))

  it('parses contiguously with no ambient trivia, without throwing', () => {
    const r = run(cleared.pair as Combinator<unknown>, 'a:1')
    expect(r.ok).toBe(true)
    expect(r.value).toEqual(['a', ':', '1'])
  })

  it('a space between terms is NOT skipped (trivia is cleared)', () => {
    const r = run(cleared.pair as Combinator<unknown>, 'a : 1')
    expect(r.ok).toBe(false)
  })

  it('the direct parse() entry also handles a null grammarTrivia', () => {
    // Same guard bug existed in grammar.ts parse(); assert it too.
    const r = parse(cleared.pair as Combinator<unknown>, 'a:1')
    expect(r.ok).toBe(true)
  })
})
