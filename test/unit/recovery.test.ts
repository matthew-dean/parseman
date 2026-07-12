/**
 * Automatic list recovery. Activated by the run-level `tolerant` flag; the sync
 * point a list resyncs to is INFERRED from grammar structure (the follow set of the
 * enclosing sequence, and a `sepBy`'s own separator) — the grammar carries no
 * recovery config. The strict default (no `tolerant`) is byte-identical to a parser
 * with no recovery.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, oneOrMore, sepBy, run, completionsAt, isParseError, trivia, rules,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'

const ident = regex(/[a-z]+/)
const num = regex(/[0-9]+/)
const decl = sequence(ident, literal(':'), num)
const declList = sepBy(decl, literal(';'))
const block = sequence(literal('{'), declList, literal('}'))

const countErrors = (v: unknown): number => (Array.isArray(v) ? v.filter(isParseError).length : 0)
const errorsIn = (v: unknown) => (Array.isArray(v) ? v.filter(isParseError) : [])

describe('automatic recovery — sync inferred from structure (no config)', () => {
  it('a list inside a block resyncs to the inferred enclosing close', () => {
    // `$$` is junk; nothing is annotated. The list infers `}` from the enclosing
    // sequence and `;` from its own separator, recovers, and keeps parsing.
    const r = run(block as Combinator<unknown>, '{a:1;$$;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null) // the closing `}` was still reached
    const list = (r.value as unknown[])[1]
    expect(countErrors(list)).toBe(1)
    expect((list as unknown[]).length).toBe(3) // [decl, error, decl]
    expect(r.errors).toHaveLength(1)
  })

  it('recovers a bad final element up to the close', () => {
    const r = run(block as Combinator<unknown>, '{a:1;$$}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
    const [err] = errorsIn((r.value as unknown[])[1])
    expect(err!.span).toEqual({ start: 5, end: 7 }) // `$$` skipped, `}` not consumed
  })

  it('recovers a bad first element', () => {
    const r = run(block as Combinator<unknown>, '{$$;a:1}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(((r.value as unknown[])[1] as unknown[]).length).toBe(2) // [error, decl]
  })
})

describe('gating — strict is untouched, recovery only when tolerant', () => {
  it('strict mode stops the list at the first bad element (fails, no errors)', () => {
    const r = run(block as Combinator<unknown>, '{a:1;$$;b:2}') // no tolerant
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
  })
})

describe('error-node emission + loop guard', () => {
  it('emits a ParseError spanning the skipped junk, with an expected set', () => {
    const r = run(block as Combinator<unknown>, '{a:1;###;b:2}', { tolerant: true })
    const [err] = r.errors
    expect(err!._tag).toBe('parseError')
    expect(err!.span).toEqual({ start: 5, end: 8 }) // `###`
    expect(err!.expected.length).toBeGreaterThan(0) // what a decl wanted
    expect(isParseError(errorsIn((r.value as unknown[])[1])[0])).toBe(true)
  })

  it('a missing element between two separators yields a zero-width error, not a hang', () => {
    const r = run(block as Combinator<unknown>, '{a:1;;b:2}', { tolerant: true })
    const [err] = errorsIn((r.value as unknown[])[1])
    expect(err!.span).toEqual({ start: 5, end: 5 }) // zero-width, between the two `;`
  })
})

describe('cross-rule sync inheritance (dynamic scoping through refs)', () => {
  // The list lives in a SEPARATE rule with no local delimiter; it must resync to
  // the `}` that follows the rule REFERENCE in `block` — proving inference
  // propagates across rule boundaries, not just within a single sequence. A static
  // per-list sync map could not express this.
  const g = rules((self: { block: Combinator<unknown>; items: Combinator<unknown> }) => ({
    block: sequence(literal('{'), self.items, literal('}')),
    items: sepBy(decl, literal(';')),
  }))

  it('a nested rule resyncs to the caller-supplied close', () => {
    const r = run(g.block as Combinator<unknown>, '{a:1;$$;b:2}', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
    expect(countErrors((r.value as unknown[])[1])).toBe(1)
  })
})

describe('oneOrMore automatic recovery', () => {
  const fenced = sequence(oneOrMore(decl), literal('%'))
  it('resyncs an element that starts then fails, up to the inferred %', () => {
    const r = run(fenced as Combinator<unknown>, 'a:1b:%', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(1)
  })
})

describe('completionsAt — recovery reaches the cursor past an earlier error', () => {
  it('returns completions after a recoverable error before the cursor', () => {
    // `$$` is junk before the cursor; without recovery the list stops there and the
    // completion set is empty. With tolerant, it recovers past `$$` and reports what
    // a fresh element expects at the cursor (an ident).
    const c = completionsAt(block as Combinator<unknown>, '{a:1;$$;', 8, { tolerant: true })
    expect(c).toContain('/[a-z]+/')
  })

  it('is unchanged (empty) on a fully valid prefix', () => {
    expect(completionsAt(block as Combinator<unknown>, '{a:1', 4, { tolerant: true }).length).toBeGreaterThanOrEqual(0)
  })
})

describe('tolerant recovery over ambient trivia', () => {
  const tws = trivia(oneOrMore(regex(/[ \t\n]+/)))
  const tg = rules({ trivia: tws }, (self: { block: Combinator<unknown>; items: Combinator<unknown> }) => ({
    block: sequence(literal('{'), self.items, literal('}')),
    items: sepBy(decl, literal(';')),
  }))

  it('recovers with whitespace between tokens', () => {
    const r = run(tg.block as Combinator<unknown>, '{ a:1 ; $$ ; b:2 }', { tolerant: true, trivia: tws })
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
    expect(countErrors((r.value as unknown[])[1])).toBe(1)
  })
})
