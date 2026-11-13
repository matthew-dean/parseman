import { describe, expect, it } from 'vitest'
import { candidateSet, collectAlphabet, leadTerminal, terminalId } from '../../src/compiler/token-alphabet.ts'
import { choice, literal, node, not, optional, peek, regex, sequence } from '../../src/index.ts'

// The candidate set of a decision point is the leading terminal of each arm. A
// prefix that may consume nothing is classified BEFORE its inner terminal is
// read: a zero-width prefix lets the next term lead, a nullable one leaves the
// arm without a single lead (`leadTerminal` in token-alphabet.ts).
describe('candidateSet: the leading terminals of a decision point', () => {
  const a = literal('a')
  const b = literal('b')
  const x = literal('x')
  const ident = regex(/[a-z]+/)
  const arms = {
    plain: a,
    wrapped: node('B', b),
    behindNot: sequence(not(x), ident),
    behindPeek: sequence(peek(ident), b),
    behindOptional: sequence(optional(x), a),
  }
  const alphabet = collectAlphabet([choice(arms.plain, arms.wrapped, arms.behindNot, arms.behindPeek, arms.behindOptional)])
  const id = (p: Parameters<typeof terminalId>[1]): number => {
    const n = terminalId(alphabet, p)
    if (n === undefined) throw new Error('not a terminal of the alphabet')
    return n
  }

  it('reads a terminal directly, and through a wrapper that consumes nothing first', () => {
    expect(leadTerminal(arms.plain, alphabet)).toBe(id(a))
    expect(leadTerminal(arms.wrapped, alphabet)).toBe(id(b))
  })

  it('skips a zero-width prefix: the next term leads', () => {
    expect(leadTerminal(arms.behindNot, alphabet)).toBe(id(ident))
    expect(leadTerminal(arms.behindPeek, alphabet)).toBe(id(b))
  })

  it('gives no lead after a nullable prefix, so the set is incomplete', () => {
    expect(leadTerminal(arms.behindOptional, alphabet)).toBeUndefined()
    const set = candidateSet(Object.values(arms), alphabet)
    expect(set.complete).toBe(false)
    expect(set.ids).toEqual([id(a), id(b), id(ident)])
  })

  it('is complete when every arm has a lead, and lists a shared lead once', () => {
    expect(candidateSet([arms.plain, arms.wrapped, sequence(a, b)], alphabet)).toEqual({ ids: [id(a), id(b)], complete: true })
  })

  it('is not a terminal id for a combinator outside the alphabet', () => {
    expect(terminalId(alphabet, literal('zz'))).toBeUndefined()
  })
})
