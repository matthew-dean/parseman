// Generated automatically by nearley, version 2.20.1
// http://github.com/Hardmath123/nearley
(function () {
function id(x) { return x[0]; }

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
var grammar = {
    Lexer: lexer,
    ParserRules: [
    {"name": "csv$ebnf$1", "symbols": []},
    {"name": "csv$ebnf$1", "symbols": ["csv$ebnf$1", "completeLine"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "csv", "symbols": ["csv$ebnf$1", "fields"], "postprocess": csvOf},
    {"name": "completeLine", "symbols": ["fields", "newline"], "postprocess": id},
    {"name": "fields$ebnf$1", "symbols": []},
    {"name": "fields$ebnf$1$subexpression$1", "symbols": [{"literal":","}, (lexer.has("field") ? {type: "field"} : field)]},
    {"name": "fields$ebnf$1", "symbols": ["fields$ebnf$1", "fields$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "fields", "symbols": [(lexer.has("field") ? {type: "field"} : field), "fields$ebnf$1"], "postprocess": fieldsOf},
    {"name": "newline", "symbols": [(lexer.has("newline") ? {type: "newline"} : newline)]}
]
  , ParserStart: "csv"
}
if (typeof module !== 'undefined'&& typeof module.exports !== 'undefined') {
   module.exports = grammar;
} else {
   window.grammar = grammar;
}
})();
