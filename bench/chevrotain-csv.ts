/**
 * Chevrotain CSV parser for benchmark comparison.
 * Implements the same CSV subset as examples/csv/parser.ts:
 *   - Quoted fields with "" escape
 *   - Unquoted fields (anything except comma / newline)
 *   - CRLF and LF line endings
 *   - Trailing newline optional
 */
import { createToken, Lexer, EmbeddedActionsParser } from 'chevrotain'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const Newline       = createToken({ name: 'Newline',       pattern: /\r\n|\n/ })
const Comma         = createToken({ name: 'Comma',         pattern: /,/ })
const QuotedField   = createToken({ name: 'QuotedField',   pattern: /"(?:[^"]|"")*"/ })
// Must be non-empty — Chevrotain rejects zero-length patterns. Empty fields are handled in the parser.
const UnquotedField = createToken({ name: 'UnquotedField', pattern: /[^,\r\n]+/ })

const allTokens = [Newline, Comma, QuotedField, UnquotedField]
const lexer = new Lexer(allTokens, { positionTracking: 'onlyStart' })

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
class CsvParser extends EmbeddedActionsParser {
  constructor() {
    super(allTokens, { recoveryEnabled: false })
    this.performSelfAnalysis()
  }

  csv = this.RULE('csv', (): string[][] => {
    const rows: string[][] = []
    this.MANY(() => {
      const row = this.SUBRULE(this.completeLine)
      this.ACTION(() => rows.push(row))
    })
    const last = this.SUBRULE(this.row)
    this.ACTION(() => {
      if (!(last.length === 1 && last[0] === '')) rows.push(last)
    })
    return rows
  })

  completeLine = this.RULE('completeLine', (): string[] => {
    const r = this.SUBRULE(this.row)
    this.CONSUME(Newline)
    return r
  })

  row = this.RULE('row', (): string[] => {
    const fields: string[] = []
    const first = this.SUBRULE(this.field)
    this.ACTION(() => fields.push(first))
    this.MANY(() => {
      this.CONSUME(Comma)
      const f = this.SUBRULE2(this.field)
      this.ACTION(() => fields.push(f))
    })
    return fields
  })

  field = this.RULE('field', (): string => {
    // OPTION wraps both alternatives so an empty field (next token is comma/newline) returns ''
    let value = ''
    this.OPTION(() => {
      value = this.OR([
        { ALT: () => {
          const tok = this.CONSUME(QuotedField)
          return tok.image.slice(1, -1).replace(/""/g, '"')
        }},
        { ALT: () => this.CONSUME(UnquotedField).image },
      ])
    })
    return value
  })
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export function buildChevrotainCSV(): (input: string) => string[][] {
  const parser = new CsvParser()
  return (input: string): string[][] => {
    const lexResult = lexer.tokenize(input)
    parser.input = lexResult.tokens
    return parser.csv()
  }
}
