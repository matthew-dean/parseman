import { describe, expect, it } from 'vitest'
import { collectAlphabet } from '../../src/compiler/token-alphabet.ts'
import { emitScanner, finalizeScanner } from '../../src/compiler/token-scanner.ts'
import { choice, literal, regex, sequence } from '../../src/index.ts'

/**
 * The scanner's memo is MODULE state in the emitted artifact. It was keyed on
 * `(pos, mode, set)` only — so a second parse of a DIFFERENT string hit the first
 * string's cached token at the same position and returned it. A wrong token from a
 * warm cache, no error, and nothing in the repo could catch it because the scanner
 * is not yet wired into any grammar.
 *
 * This asserts the emitted SOURCE, not runtime behaviour, and says so: the scanner
 * has no consumer to run it through yet. A source assertion is weak evidence of
 * correctness and strong evidence of regression, which is the right trade while the
 * module is unreferenced build-out. Replace it with a behavioural test the moment
 * anything parses through the scanner.
 */
describe('token scanner memo — input identity is part of the key', () => {
  const emitted = (): string => {
    const g = choice(sequence(literal('a'), literal('b')), regex(/[0-9]+/))
    const alphabet = collectAlphabet([g])
    return finalizeScanner(emitScanner(alphabet, '_t')).join('\n')
  }

  it('declares a memo slot for the input', () => {
    expect(emitted()).toMatch(/_tkMemoInput/)
  })

  it('tests the input BEFORE returning a cached token', () => {
    const src = emitted()
    const guard = src.split('\n').find(l => l.includes('_tkMemoPos') && l.includes('return'))
    expect(guard, 'the memo hit guard must exist').toBeDefined()
    expect(guard, 'a cached token must not be returned for a different input').toMatch(/input === \S*_tkMemoInput/)
  })

  it('stores the input alongside the position it cached', () => {
    const src = emitted()
    const store = src.split('\n').find(l => l.includes('_tkMemoPos') && l.includes('= pos'))
    expect(store).toBeDefined()
    expect(store).toMatch(/_tkMemoInput\s*=\s*input/)
  })
})
