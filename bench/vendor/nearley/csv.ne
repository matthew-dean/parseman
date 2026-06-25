# CSV parser — ported from bench/csv.pegjs for benchmark parity (string[][] rows).

@{%
const moo = require('moo')

const lexer = moo.compile({
  newline: { match: /\r\n|\n|\r/, lineBreaks: true },
  comma: ',',
  field: {
    match: /"(?:[^"]|"")*"|[^,\r\n]+/,
    value: (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s),
  },
})

function id(d) { return d[0]; }

function fieldsOf(d) {
  return [d[0].value].concat(d[1].map((x) => x[1].value))
}

function csvOf(d) {
  const lines = d[0]
  const last = d[1]
  if (last.length === 1 && last[0] === '') return lines
  return lines.concat([last])
}
%}

@lexer lexer

csv -> completeLine:* fields {% csvOf %}

completeLine -> fields newline {% id %}

fields -> %field ("," %field):* {% fieldsOf %}

newline -> %newline
