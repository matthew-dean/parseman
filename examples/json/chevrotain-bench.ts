/**
 * JSON recognizer for the Chevrotain.io performance benchmark.
 *
 * Syntactic analysis only — no string unescape, no object/array materialization.
 * Alternative order follows the Chevrotain embedded parser:
 * string, number, object, array, true, false, null.
 *
 * Built to browser JS via: pnpm build:chevrotain-bench [out.js]
 */
import {
  literal, regex, sequence, choice, optional, sepBy,
  transform, trivia, parser, rules, label,
  type Combinator,
} from '../../src/index.ts'

const ws = trivia(regex(/[ \t\n\r]*/))

const stringToken = label('string', regex(/"(?:[^\\"]|\\(?:[bfnrtv"\\/]|u[0-9a-fA-F]{4}))*"/))
const numberToken = label('number', regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/))

const voidOf = <T>(c: Combinator<T>): Combinator<undefined> =>
  transform(c, () => undefined)

export const { jsonValue } = rules<{ jsonValue: Combinator<undefined> }>(g => {
  const comma = literal(',')

  const jsonObject = voidOf(sequence(
    literal('{'),
    optional(sepBy(
      sequence(stringToken, literal(':'), g.jsonValue as Combinator<undefined>),
      comma,
    )),
    literal('}'),
  ))

  const jsonArray = voidOf(sequence(
    literal('['),
    optional(sepBy(g.jsonValue as Combinator<undefined>, comma)),
    literal(']'),
  ))

  return {
    jsonValue: choice(
      voidOf(stringToken),
      voidOf(numberToken),
      jsonObject,
      jsonArray,
      voidOf(literal('true')),
      voidOf(literal('false')),
      voidOf(literal('null')),
    ) as Combinator<undefined>,
  }
})

export const jsonRecognize = parser({ trivia: ws }, jsonValue)

export function parseRecognize(input: string): void {
  const result = jsonRecognize.parse(input)
  if (!result.ok) {
    throw new SyntaxError(
      `JSON recognize error at offset ${result.span.start}: expected ${result.expected.join(' or ')}`,
    )
  }
}
