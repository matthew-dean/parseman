/**
 * CSV parser built with parseman.
 *
 * Supports:
 * - Quoted fields (with "" escape for literal quote)
 * - Unquoted fields (any char except comma and newline)
 * - CRLF and LF line endings
 * - Trailing newline optional
 *
 * No recursion needed — fully compilable with the macro plugin.
 */
import {
  literal, regex, sequence, choice, many, transform, optional, sepBy,
  parse, compile,
  type Combinator,
} from '../../src/index.ts'

// Quoted field: "..." with "" as escaped quote
const quotedField: Combinator<string> = transform(
  sequence(
    literal('"'),
    many(choice(
      transform(literal('""'), () => '"'),
      regex(/[^"]+/)
    )),
    literal('"'),
  ),
  ([, parts]) => parts.join('')
)

// Unquoted field: anything except comma, CR, LF
const unquotedField: Combinator<string> = regex(/[^,\r\n]*/)

const field: Combinator<string> = choice(quotedField, unquotedField)

const comma = literal(',')
const newline = choice(literal('\r\n'), literal('\n'))

const row: Combinator<string[]> = sepBy(field, comma)

// A complete line = row + newline terminator
const completeLine: Combinator<string[]> = transform(
  sequence(row, newline),
  ([r]) => r
)

// CSV = zero or more complete lines, then an optional unterminated final row
const csv: Combinator<string[][]> = transform(
  sequence(many(completeLine), row),
  ([rows, last]) => {
    // row always succeeds (sepBy returns [] or [''] at EOF); drop a trailing empty row
    if (last.length === 1 && last[0] === '') return rows
    return [...rows, last]
  }
)

export { csv as csvParser, row as csvRow, field as csvField }

/** Parse CSV text into a 2D array of strings. */
export function parseCSV(input: string): string[][] {
  const result = parse(csv, input)
  if (!result.ok) throw new Error(`CSV parse error at offset ${result.span.start}`)
  return result.value
}

/** Compiled version of the CSV parser for benchmarking. */
export const compiledCSV = compile(csv)
