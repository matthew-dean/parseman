import { describe, it, expect } from 'vitest'
import { literal, choice, parse, regex, transform } from '../../src/index.ts'

describe('choice', () => {
  it('matches first alternative', () => {
    const p = choice(literal('foo'), literal('bar'))
    const r = parse(p, 'foo')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('foo')
  })

  it('falls through to second alternative', () => {
    const p = choice(literal('foo'), literal('bar'))
    const r = parse(p, 'bar')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('bar')
  })

  it('fails when nothing matches', () => {
    const p = choice(literal('foo'), literal('bar'))
    expect(parse(p, 'baz').ok).toBe(false)
  })

  it('detects disjoint first sets', () => {
    // 'a' and 'b' have disjoint first chars
    const p = choice(literal('apple'), literal('banana'))
    expect((p._meta as { disjoint?: boolean }).disjoint).toBe(true)
  })

  it('detects overlapping first sets', () => {
    // both start with 'f'
    const p = choice(literal('foo'), literal('far'))
    expect((p._meta as { disjoint?: boolean }).disjoint).toBe(false)
  })

  it('uses fast dispatch for disjoint choices', () => {
    const p = choice(literal('apple'), literal('banana'), literal('cherry'))
    expect(parse(p, 'banana').ok).toBe(true)
    expect(parse(p, 'cherry').ok).toBe(true)
  })

  it('dispatches disjoint ASCII choices without probing earlier arms', () => {
    const a = literal('a')
    const b = literal('b')
    const c = literal('c')
    const calls: [number, number, number] = [0, 0, 0]
    const ap = a.parse.bind(a)
    const bp = b.parse.bind(b)
    const cp = c.parse.bind(c)
    a.parse = (input, pos, ctx) => { calls[0]++; return ap(input, pos, ctx) }
    b.parse = (input, pos, ctx) => { calls[1]++; return bp(input, pos, ctx) }
    c.parse = (input, pos, ctx) => { calls[2]++; return cp(input, pos, ctx) }
    const r = parse(choice(a, b, c), 'c')
    expect(r.ok).toBe(true)
    expect(calls).toEqual([0, 0, 1])
  })

  it('collects expected labels on failure', () => {
    const p = choice(literal('foo'), literal('bar'))
    const r = parse(p, 'baz')
    expect(r.ok).toBe(false)
    // 'baz' starts with 'b' — disjoint dispatch only tries 'bar' (f ≠ b),
    // so only '"bar"' appears in expected. '"foo"' is correctly absent.
    if (!r.ok) expect(r.expected).toContain('"bar"')
  })

  it('collects all expected labels when no first-set matches', () => {
    const p = choice(literal('foo'), literal('bar'))
    const r = parse(p, '123')
    expect(r.ok).toBe(false)
    // '1' matches neither first set — both labels collected
    if (!r.ok) {
      expect(r.expected).toContain('"foo"')
      expect(r.expected).toContain('"bar"')
    }
  })
})

describe('choice — firstMatch auto-not (overlapping arms force a rollback)', () => {
  // Adding a 3rd, non-literal arm keeps the strategy at `firstMatch` (not
  // `literalsLongestFirst`, which only applies when EVERY arm is a literal, and
  // not `greedyClassify`, which needs exactly one regex arm that subsumes every
  // literal). `firstMatch` is the only strategy that computes and fires auto-not
  // checks — a shorter literal arm that's a real prefix of what comes later must
  // roll back and try the next arm instead of stopping short.

  it('startsWith auto-not: a literal that is a prefix of a LATER literal arm rolls back', () => {
    const p = choice(literal('foo'), literal('foobar'), regex(/[0-9]+/))
    // 'foo' alone still wins when there's no continuation into 'bar'.
    expect(parse(p, 'foo!').ok).toBe(true)
    if (parse(p, 'foo!').ok) expect((parse(p, 'foo!') as { value: unknown }).value).toBe('foo')
    // But 'foobar' as input must not stop at the first arm's 'foo' — auto-not
    // detects the 'bar' continuation and rolls back to the 'foobar' arm.
    const r = parse(p, 'foobar')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('foobar')
  })

  it('firstSet auto-not: a literal that could continue into a LATER regex arm rolls back', () => {
    const p = choice(literal('foo'), regex(/[a-z]+/), regex(/[0-9]+/))
    // Exact 'foo' with no continuation: the literal arm wins outright.
    const exact = parse(p, 'foo')
    expect(exact.ok).toBe(true)
    if (exact.ok) expect(exact.value).toBe('foo')
    // 'fooz': 'z' continues the [a-z]+ arm past what the literal matched, so
    // auto-not fires and the regex arm wins with the full, longer match.
    const longer = parse(p, 'fooz')
    expect(longer.ok).toBe(true)
    if (longer.ok) expect(longer.value).toBe('fooz')
  })

  it('rolls back captured trivia-log state when auto-not fires', () => {
    // Exercises the rollback alongside a real _triviaLog array on ctx (not just
    // CST capture) — the interpreter must truncate it back to the mark taken
    // before the losing arm ran, same as it does for the plain-failure path.
    const p = choice(literal('foo'), regex(/[a-z]+/), regex(/[0-9]+/))
    const log: number[] = [1, 2, 3]
    const ctx = { trackLines: false, _triviaLog: log }
    const r = p.parse('fooz', 0, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('fooz')
    expect(ctx._triviaLog).toEqual([1, 2, 3])
  })

  it('greedyClassify applies a wrapping transform on the winning literal arm', () => {
    // superIndex arm (the regex) subsumes the literal, but the literal arm
    // itself is wrapped in transform() — applyTransforms must recurse through
    // it rather than only handling a bare literal.
    const p = choice(transform(literal('foo'), (v: string) => v.toUpperCase()), regex(/[a-z]+/))
    const r = parse(p, 'foo')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('FOO')
    // Non-subsumed input still falls through to the regex arm untransformed.
    const r2 = parse(p, 'foobar')
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value).toBe('foobar')
  })
})
