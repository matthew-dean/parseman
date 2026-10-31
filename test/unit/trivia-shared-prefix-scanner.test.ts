import { describe, it, expect } from 'vitest'
import { classifiedTrivia, regex } from '../../src/index.ts'
import { fastTriviaScanner } from '../../src/combinators/trivia-skip.ts'

/*
 * jess writes its document comment arm as ONE regex for both comment forms,
 * `\/(?:\*(?:[^*]|\*(?!\/))*\*\/|\/[^\n\r]*)`: a literal `/` shared by a block
 * comment and a line comment. Each `<literal><alt>` is a shape the scanner
 * already lowers, but the alternation as a whole had no lowering, so the trivia
 * it sits in had no unlabelled scanner and every gap ran the labelled path.
 */

const COMMENT = /\/(?:\*(?:[^*]|\*(?!\/))*\*\/|\/[^\n\r]*)/
const ALPHABET = [' ', '\n', '\r', '/', '*', 'a']

/** Every string over `ALPHABET` up to `max` characters. */
function* strings(max: number): Generator<string> {
  let layer = ['']
  for (let n = 0; n < max; n++) {
    const next: string[] = []
    for (const s of layer) for (const c of ALPHABET) next.push(s + c)
    yield* next
    layer = next
  }
}

describe('a trivia arm whose alternatives share a literal prefix', () => {
  it('has an unlabelled scanner that ends where the regex does', () => {
    const t = classifiedTrivia({ whitespace: regex(/[ \t\n\r\f]+/), comment: regex(COMMENT) })
    const scan = fastTriviaScanner(t)
    expect(scan).toBeTypeOf('function')
    const ref = new RegExp(`(?:[ \\t\\n\\r\\f]+|${COMMENT.source})+`, 'y')
    let checked = 0
    for (const input of strings(6)) {
      ref.lastIndex = 0
      const want = ref.exec(input)?.[0].length ?? 0
      expect(scan!(input, 0), JSON.stringify(input)).toBe(want)
      checked++
    }
    expect(checked).toBe(55986)
  })

  it('declines an alternation it cannot lower whole', () => {
    // `(?:a+|b)` after the shared literal: `/a+` is not a lowered shape.
    expect(fastTriviaScanner(classifiedTrivia({ c: regex(/\/(?:a+|\/[^\n]*)/) }))).toBeNull()
    // Unbalanced or ungrouped bodies are not this shape at all.
    expect(fastTriviaScanner(classifiedTrivia({ c: regex(/\/(?:\*\/)|x/) }))).toBeNull()
  })
})
