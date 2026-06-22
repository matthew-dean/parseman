/**
 * JSONL (newline-delimited JSON) parser.
 *
 * Extends the base JSON parser with one combinator:
 * one value per line, lines separated by '\n'.
 *
 * Format: https://jsonlines.org
 */
import { sepBy, transform, literal, parse } from '../../src/index.ts'
import { jsonValue, type JSONValue } from './parser.ts'

export const jsonl = transform(
  sepBy(jsonValue, literal('\n')),
  lines => lines
)

export function parseJSONL(input: string): JSONValue[] {
  const result = parse(jsonl, input.trim())
  if (!result.ok) throw new SyntaxError(`JSONL parse error at offset ${result.span.start}`)
  return result.value
}
