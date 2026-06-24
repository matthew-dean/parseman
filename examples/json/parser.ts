/**
 * JSON parser built with parseman.
 *
 * Demonstrates:
 * - Recursive grammars via rules() — write grammar rules that reference each
 *   other naturally; the engine handles forward declarations behind the scenes
 * - choice() with disjoint first-set dispatch ('{', '[', '"', digit/'-', 't', 'f', 'n')
 * - trivia for automatic whitespace skipping
 * - transform() for value construction
 * - Macro compilation of recursive grammars — the rules() factory is evaluated
 *   at build time by the parseman Vite/Rollup plugin, emitting optimized inline
 *   functions with no runtime combinator overhead.
 *
 * To extend this parser see:
 *   examples/json/jsonl.ts  — newline-delimited JSON
 *   examples/json/jsonc.ts  — JSON with // and /* comments
 */
import {
  literal, regex, sequence, choice, optional, sepBy,
  transform, trivia, parser, rules,
  type Combinator,
} from '../../src/index.ts'

function unescapeJsonString(inner: string): string {
  if (!inner.includes('\\')) return inner
  return inner
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\\//g, '/')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

function objectFromPairs<V>(pairs: ReadonlyArray<readonly [string, V]>): Record<string, V> {
  const obj = Object.create(null) as Record<string, V>
  for (const [k, v] of pairs) obj[k] = v
  return obj
}

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------
export const ws = trivia(regex(/[ \t\n\r]*/))

// ---------------------------------------------------------------------------
// Primitives (non-recursive — defined outside rules())
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
  ([, inner]) => unescapeJsonString(inner),
)

// ---------------------------------------------------------------------------
// Recursive grammar
// ---------------------------------------------------------------------------
export type JSONValue = null | boolean | number | string | JSONValue[] | Record<string, JSONValue>

// rules() defines the mutually recursive portion. Local helpers (comma, key, pair)
// are plain consts inside the factory — they don't need to appear in the returned
// object because no other rule references them via `g.*`.
export const { jsonValue } = rules<{ jsonValue: Combinator<JSONValue> }>(g => {
  const comma = literal(',')

  const jsonArray = transform(
    sequence(literal('['), optional(sepBy(g.jsonValue as Combinator<JSONValue>, comma)), literal(']')),
    ([, items]) => (items ?? []) as JSONValue[]
  )

  const jsonKey = transform(
    sequence(jsonString, literal(':')),
    ([key]) => key
  )
  const jsonPair = transform(
    sequence(jsonKey, g.jsonValue as Combinator<JSONValue>),
    ([key, val]) => [key, val] as [string, JSONValue]
  )

  const jsonObject = transform(
    sequence(literal('{'), optional(sepBy(jsonPair, comma)), literal('}')),
    ([, pairs]) => objectFromPairs(pairs ?? []) as Record<string, JSONValue>,
  )

  return {
    jsonValue: choice(jsonObject, jsonArray, jsonString, jsonNumber, jsonTrue, jsonFalse, jsonNull) as Combinator<JSONValue>,
  }
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Document-level JSON parser with trivia baked in. */
export const jsonDoc = parser({ trivia: ws }, jsonValue)

export function parseJSON(input: string): JSONValue {
  const result = jsonDoc.parse(input.trim())
  if (!result.ok) {
    throw new SyntaxError(
      `JSON parse error at offset ${result.span.start}: expected ${result.expected.join(' or ')}`
    )
  }
  return result.value
}

/**
 * Factory for building JSON-like parsers with a custom trivia (whitespace+comments) parser.
 * Returns a self-contained parser with trivia baked in — no need to pass trivia to parse().
 * Used by jsonc.ts to add comment support.
 */
export function makeJSONParser(customWs: typeof ws = ws) {
  const { value } = rules<{ value: Combinator<JSONValue> }>(g => {
    const comma = literal(',')

    const array = transform(
      sequence(literal('['), optional(sepBy(g.value as Combinator<JSONValue>, comma)), literal(']')),
      ([, items]) => (items ?? []) as JSONValue[]
    )
    const key = transform(
      sequence(jsonString, literal(':')),
      ([k]) => k
    )
    const pair = transform(
      sequence(key, g.value as Combinator<JSONValue>),
      ([k, v]) => [k, v] as [string, JSONValue]
    )
    const object = transform(
      sequence(literal('{'), optional(sepBy(pair, comma)), literal('}')),
      ([, pairs]) => objectFromPairs(pairs ?? []) as Record<string, JSONValue>,
    )

    return {
      value: choice(object, array, jsonString, jsonNumber, jsonTrue, jsonFalse, jsonNull) as Combinator<JSONValue>,
    }
  })
  return parser({ trivia: customWs }, value)
}
