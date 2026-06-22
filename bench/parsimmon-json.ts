/**
 * Parsimmon JSON parser for benchmark comparison.
 * Implements the same JSON subset as examples/json/parser.ts.
 */
import P from 'parsimmon'

const JsonParser = P.createLanguage({
  value: r => P.alt(
    r.object,
    r.array,
    r.string,
    r.number,
    r.true,
    r.false,
    r.null,
  ).trim(r.ws),

  ws: () => P.optWhitespace,

  object: r => r.pair
    .sepBy(P.string(',').trim(r.ws))
    .wrap(P.string('{').trim(r.ws), P.string('}').trim(r.ws))
    .map(pairs => Object.fromEntries(pairs)),

  pair: r => P.seqMap(
    r.string.skip(P.string(':').trim(r.ws)),
    r.value,
    (key, val) => [key, val] as [string, unknown],
  ),

  array: r => r.value
    .sepBy(P.string(',').trim(r.ws))
    .wrap(P.string('[').trim(r.ws), P.string(']').trim(r.ws)),

  string: () => P.regexp(/"(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/)
    .map(s => JSON.parse(s) as string),

  number: () => P.regexp(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    .map(Number),

  true:  () => P.string('true').result(true),
  false: () => P.string('false').result(false),
  null:  () => P.string('null').result(null),
})

export function buildParsimmonJSON(): (input: string) => unknown {
  return (input: string) => {
    const result = JsonParser.value.parse(input.trim())
    if (!result.status) throw new SyntaxError(`Parsimmon: ${result.expected.join(', ')}`)
    return result.value
  }
}
