/**
 * JSONC — JSON with comments (line and block).
 *
 * Extends the base JSON parser by replacing its trivia parser
 * with one that also skips // and /* comments.
 *
 * Uses makeJSONParser() from parser.ts — the grammar is identical,
 * only the whitespace/trivia rule changes.
 */
import { choice, regex, trivia, many, transform, parse } from '../../src/index.ts'
import { makeJSONParser, type JSONValue } from './parser.ts'

// Each token: a comment OR non-empty whitespace
const wsOrComment = choice(
  regex(/\/\/[^\n]*/),        // // line comment (no newline consumed — newline is whitespace)
  regex(/\/\*[\s\S]*?\*\//), // /* block comment */
  regex(/[ \t\n\r]+/),        // whitespace (+ so many() terminates)
)

// Trivia = zero or more whitespace/comment tokens
const jsoncWs = trivia(
  transform(many(wsOrComment), () => '')
)

export const jsoncValue = makeJSONParser(jsoncWs)

export function parseJSONC(input: string): JSONValue {
  const result = parse(jsoncValue, input.trim(), { trivia: jsoncWs })
  if (!result.ok) {
    throw new SyntaxError(`JSONC parse error at offset ${result.span.start}`)
  }
  return result.value
}
