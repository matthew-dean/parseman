import { describe, expect, it } from 'vitest'
import {
  literal, many, parse, parser, regex, sequence, transform, trivia,
  type Combinator,
} from '../../src/index.ts'
import { scalarRootOf } from '../../src/combinators/scalar.ts'
import { createParseContext } from '../../src/parse-context.ts'

const ws = trivia(regex(/\s+/))

describe('strict scalar interpreter parity', () => {
  it('keeps ambient trivia semantics in the fused JSON-string transform', () => {
    const jsonBody = regex(/(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/)
    const quoted = parser({ trivia: ws }, transform(
      sequence(literal('"'), jsonBody, literal('"')),
      ([, body]) => body,
    ))

    const fast = parse(quoted, '" value"')
    const general = quoted.parse('" value"', 0, createParseContext())
    expect(fast).toMatchObject({ ok: true, value: 'value' })
    expect(fast).toEqual(general)
  })

  it('anchors a missing mandatory item before inter-item trivia', () => {
    const repeated = parser({ trivia: ws }, many(literal('a'), { min: 2 }))

    const fast = parse(repeated, 'a ')
    const general = repeated.parse('a ', 0, createParseContext())
    expect(fast).toMatchObject({ ok: false, span: { start: 1, end: 1 } })
    expect(fast).toEqual(general)
  })

  it('rejects an unrecognized definition even if it advertises a scalar parser', () => {
    const unknown: Combinator<string> = {
      _tag: 'unknown',
      _meta: { firstSet: { kind: 'any' }, canMatchNewline: true, isTrivia: false },
      _def: { tag: 'unknown' },
      _parseScalar(input, pos, ctx) {
        ctx._sv = input[pos]
        return pos + 1
      },
      parse(input, pos) {
        return { ok: true, value: input[pos]!, span: { start: pos, end: pos + 1 } }
      },
    }
    const wrapped = parser({}, transform(unknown, value => value))

    expect(scalarRootOf(wrapped)).toBeUndefined()
  })
})
