/**
 * JSON parser built with parseman.
 *
 * Demonstrates:
 * - Recursive grammars via parser() — write grammar parser that reference each
 *   other naturally; the engine handles forward declarations behind the scenes
 * - choice() with disjoint first-set dispatch ('{', '[', '"', digit/'-', 't', 'f', 'n')
 * - trivia for automatic whitespace skipping
 * - transform() for value construction
 *
 * To extend this parser see:
 *   examples/json/jsonl.ts  — newline-delimited JSON
 *   examples/json/jsonc.ts  — JSON with // and /* comments
 *
 * Macro note:
 *   The recursive structure (value → array → value) prevents full build-time
 *   compilation. For non-recursive parsers you can use:
 *     import { ... } from 'parseman' with { type: 'macro' }
 *   and a bundler with the parseman Vite/Rollup plugin to inline compiled code.
 *   See examples/vite.config.ts.
 */
import {
  literal, regex, sequence, choice, optional, sepBy,
  transform, trivia, parser, parse,
  type Combinator,
} from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------
export const ws = trivia(regex(/[ \t\n\r]*/))

// ---------------------------------------------------------------------------
// Primitives (non-recursive — defined outside parser())
// ---------------------------------------------------------------------------
const jsonNull  = transform(literal('null'),  () => null)
const jsonTrue  = transform(literal('true'),  () => true)
const jsonFalse = transform(literal('false'), () => false)

const jsonNumber = transform(
  regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/),
  s => parseFloat(s)
)

const jsonStringInner = regex(/(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*/)
export const jsonString = transform(
  sequence(literal('"'), jsonStringInner, literal('"')),
  ([, inner]) => inner
    .replace(/\\"/g,  '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\\//g, '/')
    .replace(/\\b/g,  '\b')
    .replace(/\\f/g,  '\f')
    .replace(/\\n/g,  '\n')
    .replace(/\\r/g,  '\r')
    .replace(/\\t/g,  '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
)

// ---------------------------------------------------------------------------
// Recursive grammar
// ---------------------------------------------------------------------------
export type JSONValue = null | boolean | number | string | JSONValue[] | Record<string, JSONValue>

// parser() defines the mutually recursive portion. Local helpers (comma, key, pair)
// are plain consts inside the factory — they don't need to appear in the returned
// object because no other rule references them via `g.*`.
export const { jsonValue } = parser<{ jsonValue: Combinator<JSONValue> }>(g => {
  const comma = sequence(ws, literal(','), ws)

  const jsonArray = transform(
    sequence(literal('['), optional(sepBy(g.jsonValue as Combinator<JSONValue>, comma)), literal(']')),
    ([, items]) => (items ?? []) as JSONValue[]
  )

  const jsonKey = transform(
    sequence(ws, jsonString, ws, literal(':')),
    ([, key]) => key
  )
  const jsonPair = transform(
    sequence(jsonKey, g.jsonValue as Combinator<JSONValue>),
    ([key, val]) => [key, val] as [string, JSONValue]
  )

  const jsonObject = transform(
    sequence(literal('{'), optional(sepBy(jsonPair, comma)), literal('}')),
    ([, pairs]) => Object.fromEntries(pairs ?? []) as Record<string, JSONValue>
  )

  return {
    jsonValue: choice(jsonObject, jsonArray, jsonString, jsonNumber, jsonTrue, jsonFalse, jsonNull) as Combinator<JSONValue>,
  }
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function parseJSON(input: string): JSONValue {
  const result = parse(jsonValue, input.trim(), { trivia: ws })
  if (!result.ok) {
    throw new SyntaxError(
      `JSON parse error at offset ${result.span.start}: expected ${result.expected.join(' or ')}`
    )
  }
  return result.value
}

/**
 * Factory for building JSON-like parsers with a custom trivia (whitespace+comments) parser.
 * Used by jsonc.ts to add comment support.
 */
export function makeJSONParser(customWs: typeof ws = ws): Combinator<JSONValue> {
  const { value } = parser<{ value: Combinator<JSONValue> }>(g => {
    const comma = sequence(customWs, literal(','), customWs)

    const array = transform(
      sequence(literal('['), optional(sepBy(g.value as Combinator<JSONValue>, comma)), literal(']')),
      ([, items]) => (items ?? []) as JSONValue[]
    )
    const key = transform(
      sequence(customWs, jsonString, customWs, literal(':')),
      ([, k]) => k
    )
    const pair = transform(
      sequence(key, g.value as Combinator<JSONValue>),
      ([k, v]) => [k, v] as [string, JSONValue]
    )
    const object = transform(
      sequence(literal('{'), optional(sepBy(pair, comma)), literal('}')),
      ([, pairs]) => Object.fromEntries(pairs ?? []) as Record<string, JSONValue>
    )

    return {
      value: choice(object, array, jsonString, jsonNumber, jsonTrue, jsonFalse, jsonNull) as Combinator<JSONValue>,
    }
  })
  return value
}

// Note: callers of makeJSONParser() must pass { trivia: customWs } to parse()
