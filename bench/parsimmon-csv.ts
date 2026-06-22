/**
 * Parsimmon CSV parser for benchmark comparison.
 */
import P from 'parsimmon'

const CsvParser = P.createLanguage({
  csv: r => P.seqMap(
    r.completeLine.many(),
    r.row,
    (lines, last) => {
      if (last.length === 1 && last[0] === '') return lines
      return [...lines, last]
    }
  ),

  completeLine: r => r.row.skip(r.newline),

  row: r => r.field.sepBy(P.string(',')),

  field: r => P.alt(r.quotedField, r.unquotedField),

  quotedField: () => P.seqMap(
    P.string('"'),
    P.alt(P.string('""').result('"'), P.regexp(/[^"]+/)).many(),
    P.string('"'),
    (_, parts) => parts.join('')
  ),

  unquotedField: () => P.regexp(/[^,\r\n]*/),

  newline: () => P.alt(P.string('\r\n'), P.string('\n')),
})

export function buildParsimmonCSV(): (input: string) => string[][] {
  return (input: string) => {
    const result = CsvParser.csv.parse(input)
    if (!result.status) throw new Error('Parsimmon CSV parse failed')
    return result.value
  }
}
