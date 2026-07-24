/**
 * Branch/coverage detail for the gating analyzer — every cause classification,
 * firstSetToString, wrapper peeling, and the visit tree-walk edges.
 */
import { describe, it, expect } from 'vitest'
import {
  analyzeGating, formatGatingWarnings, firstSetToString,
  choice, sequence, literal, regex, not, gate, optional, many,
  oneOrMore, transform, label, node, scanTo, sepBy, token, rules, withCtx,
} from '../../src/index.ts'
import type { Combinator, FirstSet } from '../../src/index.ts'

const broad = () => regex(/[\s\S]*/)          // first-set ANY
const anyArm = (c: Combinator<unknown>) => analyzeGating(c).choices[0]!.anyArms[0]!

describe('firstSetToString', () => {
  it('renders any / empty / single / range / non-printable', () => {
    expect(firstSetToString({ kind: 'any' })).toBe('ANY')
    expect(firstSetToString({ kind: 'empty' })).toBe('(empty)')
    expect(firstSetToString({ kind: 'ranges', ranges: [{ lo: 97, hi: 97 }] })).toBe("'a'")
    expect(firstSetToString({ kind: 'ranges', ranges: [{ lo: 97, hi: 122 }] })).toBe("'a'-'z'")
    const nonPrintable: FirstSet = { kind: 'ranges', ranges: [{ lo: 9, hi: 9 }] }
    expect(firstSetToString(nonPrintable)).toBe('\\u9')
  })
})

describe('classifyBroadArm — every cause', () => {
  it('broad-recognizer (bare broad regex)', () => {
    expect(anyArm(choice(broad(), literal('z'))).cause).toBe('broad-recognizer')
  })
  it('broad-recognizer (scanTo)', () => {
    expect(anyArm(choice(scanTo(literal(';')), literal('z'))).cause).toBe('broad-recognizer')
  })
  it('broad-recognizer (leading broad in a sequence)', () => {
    const a = anyArm(choice(sequence(broad(), literal('x')), literal('z')))
    expect(a.cause).toBe('broad-recognizer')
  })
  it('leading-not (arm is a bare not)', () => {
    expect(anyArm(choice(not(literal('x')), literal('z'))).cause).toBe('leading-not')
  })
  it('opaque-wrapper (gate/guard predicate arm)', () => {
    expect(anyArm(choice(gate(() => true), literal('z'))).cause).toBe('opaque-wrapper')
  })
  it('withCtx forwards its first-set — walk INTO it to the real broad inner', () => {
    // withCtx delegates first-set to its inner, so the cause is the inner parser,
    // not a generic opaque-wrapper.
    expect(anyArm(choice(withCtx({}, broad()), literal('z'))).cause).toBe('broad-recognizer')
  })
  it('nullable-prefix (many over a broad body)', () => {
    const a = anyArm(choice(many(broad()), literal('z')))
    expect(a.cause).toBe('nullable-prefix')
  })
  it('nullable-prefix (optional over a broad body)', () => {
    const a = anyArm(choice(optional(broad()), literal('z')))
    expect(a.cause).toBe('nullable-prefix')
  })
  it('nullable-prefix (a FINITE optional prefix masking a later broad term)', () => {
    // sequence(optional('a'), broad): the optional gates finitely but is nullable,
    // so the sequence first-set is ANY via the broad tail — cause is nullable-prefix.
    const a = anyArm(choice(sequence(optional(literal('a')), broad()), literal('z')))
    expect(a.cause).toBe('nullable-prefix')
  })
  it('walks through oneOrMore/transform/label/node/token wrappers', () => {
    expect(anyArm(choice(oneOrMore(broad()), literal('z'))).cause).toBe('broad-recognizer')
    expect(anyArm(choice(transform(broad(), (v) => v), literal('z'))).cause).toBe('broad-recognizer')
    expect(anyArm(choice(label('l', broad()), literal('z'))).cause).toBe('broad-recognizer')
    expect(anyArm(choice(node('N', broad()), literal('z'))).cause).toBe('broad-recognizer')
    expect(anyArm(choice(token(broad()), literal('z'))).cause).toBe('broad-recognizer')
  })
  it('recurses into a nested choice arm', () => {
    const a = anyArm(choice(choice(broad(), literal('q')), literal('z')))
    expect(a.detail).toContain('choice arm')
  })
  it('cross-artifact-ref: a ref that resolves to a broad rule', () => {
    const { top } = rules((g) => ({
      top: choice(g.wild, literal('z')),
      wild: broad(),
    }))
    const r = analyzeGating(top as Combinator<unknown>)
    const c = r.choices.find(ch => ch.anyArms.length > 0)!
    expect(c.anyArms[0]!.cause).toBe('cross-artifact-ref')
    expect(c.anyArms[0]!.detail).toContain('g.wild')
  })
})

describe('anti-pattern peeling', () => {
  it('detects double-not through a transform/node wrapper', () => {
    const g = choice(
      node('E', sequence(not(not(literal('@'))), literal('x'))),
      literal('z'),
    )
    const r = analyzeGating(g)
    expect(r.antiPatterns.some(a => a.kind === 'double-not')).toBe(true)
  })
  it('does not flag a plain non-keyword regex', () => {
    const g = choice(sequence(regex(/[0-9]+/), literal('x')), literal('z'))
    const r = analyzeGating(g)
    expect(r.antiPatterns.some(a => a.kind === 'keyword-regex')).toBe(false)
  })
})

describe('visit tree-walk edges', () => {
  it('descends into sepBy, scanTo skip regions, and many bodies', () => {
    const inner = choice(literal('a'), regex(/[\s\S]*/))
    const g = sequence(
      sepBy(inner, literal(',')),
      scanTo(literal(';'), { skip: [choice(literal('('), literal(')'))] }),
    )
    const r = analyzeGating(g)
    // the inner broad choice (inside sepBy) is found
    expect(r.choices.some(c => c.gates === 'no')).toBe(true)
  })

  it('an accepted ungated choice is reported but excluded from warnings', () => {
    const g = choice(literal('a'), broad())
    const id = analyzeGating(g).choices[0]!.id
    const r = analyzeGating(g, { accept: [id] })
    expect(r.choices[0]!.accepted).toBe(true)
    expect(formatGatingWarnings(r)).toHaveLength(0)
  })

  it('formats overlaps in warnings (exercises firstSetToString via warnings)', () => {
    const g = choice(sequence(literal('ab'), literal('c')), sequence(literal('ad'), literal('e')))
    const out = formatGatingWarnings(analyzeGating(g)).join('\n')
    expect(out).toContain('overlap on')
  })

  it('overlap `on` is the SHARED chars (intersection), not the union', () => {
    // arm0 first-set [a-c], arm1 [b-d] → overlap is [b-c], not [a-d].
    const g = choice(
      sequence(regex(/[a-c]/), literal('x')),
      sequence(regex(/[b-d]/), literal('y')),
    )
    const o = analyzeGating(g).choices[0]!.overlaps[0]!
    expect(firstSetToString(o.on)).toBe("'b'-'c'")
  })
})
