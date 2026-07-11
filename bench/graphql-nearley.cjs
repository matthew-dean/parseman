// Generated automatically by nearley, version 2.20.1
// http://github.com/Hardmath123/nearley
(function () {
function id(x) { return x[0]; }

const moo = require('moo')

const rawLexer = moo.compile({
  ws: { match: /(?:[ \t\r\n,]|#[^\n\r]*)+/, lineBreaks: true },
  spread: '...',
  lbrace: '{',
  rbrace: '}',
  lparen: '(',
  rparen: ')',
  lbracket: '[',
  rbracket: ']',
  colon: ':',
  bang: '!',
  at: '@',
  dollar: '$',
  equals: '=',
  query: { match: /query(?![_0-9A-Za-z])/, value: () => 'query' },
  mutation: { match: /mutation(?![_0-9A-Za-z])/, value: () => 'mutation' },
  subscription: { match: /subscription(?![_0-9A-Za-z])/, value: () => 'subscription' },
  fragment: { match: /fragment(?![_0-9A-Za-z])/, value: () => 'fragment' },
  kwon: { match: /on(?![_0-9A-Za-z])/, value: () => 'on' },
  kwtrue: { match: /true(?![_0-9A-Za-z])/, value: () => 'true' },
  kwfalse: { match: /false(?![_0-9A-Za-z])/, value: () => 'false' },
  kwnull: { match: /null(?![_0-9A-Za-z])/, value: () => 'null' },
  blockString: /"""(?:\\"""|[^])*?"""/,
  string: /"(?:\\["\\bfnrt\/\\]|\\u[a-fA-F0-9]{4}|[^"\\])*"/,
  float: /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+(?:[eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)/,
  int: /-?(?:0|[1-9][0-9]*)/,
  name: /[_A-Za-z][_0-9A-Za-z]*/,
})

const lexer = Object.create(rawLexer)
lexer.next = function skipWs() {
  let tok
  do { tok = rawLexer.next() } while (tok && tok.type === 'ws')
  return tok
}
lexer.save = function() { return rawLexer.save() }
lexer.reset = function(chunk, info) { return rawLexer.reset(chunk, info) }
lexer.formatError = function(err) { return rawLexer.formatError(err) }

function id(d) { return d[0] }

function parseString(tok) {
  return JSON.parse(tok.value)
}

function parseBlockString(tok) {
  const s = tok.value
  const chars = []
  for (let i = 3; i < s.length - 3; ) {
    if (s[i] === '\\' && s.slice(i, i + 4) === '\\"""') {
      chars.push('\\', '"', '"', '"')
      i += 4
    } else if (s.slice(i, i + 3) === '"""') {
      break
    } else {
      chars.push(s[i])
      i++
    }
  }
  return chars.join('')
}

function fragmentNameOf(tok) {
  const n = tok.value
  if (n === 'on') throw new Error('FragmentName cannot be "on"')
  return n
}

function nameOf(tok) { return tok.value }

function extractList(d) {
  const output = [d[1]]
  for (const i in d[2]) output.push(d[2][i][0])
  return output
}

function extractObjectFields(d) {
  const output = [d[1]]
  for (const i in d[2]) output.push(d[2][i][0])
  return output
}

var grammar = {
    Lexer: lexer,
    ParserRules: [
    {"name": "document$ebnf$1", "symbols": ["definition"]},
    {"name": "document$ebnf$1", "symbols": ["document$ebnf$1", "definition"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "document", "symbols": ["document$ebnf$1"], "postprocess": function(d) { return d[0] }},
    {"name": "definition", "symbols": ["operationDefinition"], "postprocess": id},
    {"name": "definition", "symbols": ["fragmentDefinition"], "postprocess": id},
    {"name": "operationDefinition", "symbols": ["selectionSet"], "postprocess": 
        function(d) {
          return {
            kind: 'OperationDefinition',
            operation: 'query',
            name: null,
            variables: [],
            directives: [],
            selectionSet: d[0],
          }
        }
          },
    {"name": "operationDefinition", "symbols": ["operationType", "namedOperation"], "postprocess": 
        function(d) {
          return {
            kind: 'OperationDefinition',
            operation: d[0],
            name: d[1].name,
            variables: d[1].variables,
            directives: d[1].directives,
            selectionSet: d[1].selectionSet,
          }
        }
          },
    {"name": "namedOperation", "symbols": [(lexer.has("name") ? {type: "name"} : name), "variableDefinitionsOpt", "directivesOpt", "selectionSet"], "postprocess": 
        function(d) {
          return {
            name: nameOf(d[0]),
            variables: d[1] || [],
            directives: d[2] || [],
            selectionSet: d[3],
          }
        }
        },
    {"name": "namedOperation", "symbols": ["variableDefinitionsOpt", "directivesOpt", "selectionSet"], "postprocess": 
        function(d) {
          return {
            name: null,
            variables: d[0] || [],
            directives: d[1] || [],
            selectionSet: d[2],
          }
        }
        },
    {"name": "operationType", "symbols": [(lexer.has("query") ? {type: "query"} : query)], "postprocess": function() { return 'query' }},
    {"name": "operationType", "symbols": [(lexer.has("mutation") ? {type: "mutation"} : mutation)], "postprocess": function() { return 'mutation' }},
    {"name": "operationType", "symbols": [(lexer.has("subscription") ? {type: "subscription"} : subscription)], "postprocess": function() { return 'subscription' }},
    {"name": "variableDefinitions$ebnf$1", "symbols": ["variableDefinition"]},
    {"name": "variableDefinitions$ebnf$1", "symbols": ["variableDefinitions$ebnf$1", "variableDefinition"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "variableDefinitions", "symbols": [(lexer.has("lparen") ? {type: "lparen"} : lparen), "variableDefinitions$ebnf$1", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": function(d) { return d[1] }},
    {"name": "variableDefinition", "symbols": ["variable", (lexer.has("colon") ? {type: "colon"} : colon), "type", "defaultValueOpt"], "postprocess":  function(d) {
          return { variable: d[0].name, type: d[2], defaultValue: d[3] }
        } },
    {"name": "variable", "symbols": [(lexer.has("dollar") ? {type: "dollar"} : dollar), (lexer.has("name") ? {type: "name"} : name)], "postprocess": function(d) { return { kind: 'Variable', name: nameOf(d[1]) } }},
    {"name": "defaultValue", "symbols": [(lexer.has("equals") ? {type: "equals"} : equals), "value"], "postprocess": function(d) { return d[1] }},
    {"name": "defaultValueOpt", "symbols": ["defaultValue"], "postprocess": id},
    {"name": "defaultValueOpt", "symbols": [], "postprocess": function() { return null }},
    {"name": "selectionSet$ebnf$1", "symbols": ["selection"]},
    {"name": "selectionSet$ebnf$1", "symbols": ["selectionSet$ebnf$1", "selection"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "selectionSet", "symbols": [(lexer.has("lbrace") ? {type: "lbrace"} : lbrace), "selectionSet$ebnf$1", (lexer.has("rbrace") ? {type: "rbrace"} : rbrace)], "postprocess": function(d) { return d[1] }},
    {"name": "selection", "symbols": ["fragmentSpread"], "postprocess": id},
    {"name": "selection", "symbols": ["inlineFragment"], "postprocess": id},
    {"name": "selection", "symbols": ["field"], "postprocess": id},
    {"name": "field", "symbols": ["fieldAliasOpt", (lexer.has("name") ? {type: "name"} : name), "argumentsOpt", "directivesOpt", "selectionSetOpt"], "postprocess": 
        function(d) {
          return {
            alias: d[0],
            name: nameOf(d[1]),
            arguments: d[2] || [],
            directives: d[3] || [],
            selectionSet: d[4],
          }
        }
        },
    {"name": "fieldAliasOpt", "symbols": [(lexer.has("name") ? {type: "name"} : name), (lexer.has("colon") ? {type: "colon"} : colon)], "postprocess": function(d) { return nameOf(d[0]) }},
    {"name": "fieldAliasOpt", "symbols": [], "postprocess": function() { return null }},
    {"name": "arguments$ebnf$1", "symbols": ["argument"]},
    {"name": "arguments$ebnf$1", "symbols": ["arguments$ebnf$1", "argument"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "arguments", "symbols": [(lexer.has("lparen") ? {type: "lparen"} : lparen), "arguments$ebnf$1", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": function(d) { return d[1] }},
    {"name": "argumentsOpt", "symbols": ["arguments"], "postprocess": id},
    {"name": "argumentsOpt", "symbols": [], "postprocess": function() { return null }},
    {"name": "argument", "symbols": [(lexer.has("name") ? {type: "name"} : name), (lexer.has("colon") ? {type: "colon"} : colon), "value"], "postprocess": function(d) { return { name: nameOf(d[0]), value: d[2] } }},
    {"name": "fragmentSpread", "symbols": [(lexer.has("spread") ? {type: "spread"} : spread), "fragmentName", "directivesOpt"], "postprocess": 
        function(d) { return { kind: 'FragmentSpread', name: d[1], directives: d[2] || [] } }
        },
    {"name": "inlineFragment", "symbols": [(lexer.has("spread") ? {type: "spread"} : spread), "typeConditionOpt", "directivesOpt", "selectionSet"], "postprocess": 
        function(d) {
          return {
            kind: 'InlineFragment',
            typeCondition: d[1],
            directives: d[2] || [],
            selectionSet: d[3],
          }
        }
        },
    {"name": "fragmentDefinition", "symbols": [(lexer.has("fragment") ? {type: "fragment"} : fragment), "fragmentName", "typeCondition", "directivesOpt", "selectionSet"], "postprocess": 
        function(d) {
          return {
            kind: 'FragmentDefinition',
            name: d[1],
            typeCondition: d[2],
            directives: d[3] || [],
            selectionSet: d[4],
          }
        }
        },
    {"name": "fragmentName", "symbols": [(lexer.has("name") ? {type: "name"} : name)], "postprocess": function(d) { return fragmentNameOf(d[0]) }},
    {"name": "typeCondition", "symbols": [(lexer.has("kwon") ? {type: "kwon"} : kwon), (lexer.has("name") ? {type: "name"} : name)], "postprocess": function(d) { return nameOf(d[1]) }},
    {"name": "typeConditionOpt", "symbols": ["typeCondition"], "postprocess": id},
    {"name": "typeConditionOpt", "symbols": [], "postprocess": function() { return null }},
    {"name": "directives$ebnf$1", "symbols": ["directive"]},
    {"name": "directives$ebnf$1", "symbols": ["directives$ebnf$1", "directive"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "directives", "symbols": ["directives$ebnf$1"], "postprocess": id},
    {"name": "directivesOpt", "symbols": ["directives"], "postprocess": id},
    {"name": "directivesOpt", "symbols": [], "postprocess": function() { return null }},
    {"name": "directive", "symbols": [(lexer.has("at") ? {type: "at"} : at), (lexer.has("name") ? {type: "name"} : name), "argumentsOpt"], "postprocess":  function(d) {
          return { name: nameOf(d[1]), arguments: d[2] || [] }
        } },
    {"name": "type", "symbols": ["listType", "nonNullOpt"], "postprocess": function(d) { return d[1] ? { kind: 'NonNull', type: d[0] } : d[0] }},
    {"name": "type", "symbols": ["namedType", "nonNullOpt"], "postprocess": function(d) { return d[1] ? { kind: 'NonNull', type: d[0] } : d[0] }},
    {"name": "nonNullOpt", "symbols": [(lexer.has("bang") ? {type: "bang"} : bang)], "postprocess": function() { return true }},
    {"name": "nonNullOpt", "symbols": [], "postprocess": function() { return false }},
    {"name": "namedType", "symbols": [(lexer.has("name") ? {type: "name"} : name)], "postprocess": function(d) { return { kind: 'NamedType', name: nameOf(d[0]) } }},
    {"name": "listType", "symbols": [(lexer.has("lbracket") ? {type: "lbracket"} : lbracket), "type", (lexer.has("rbracket") ? {type: "rbracket"} : rbracket)], "postprocess": function(d) { return { kind: 'ListType', type: d[1] } }},
    {"name": "value", "symbols": ["variable"], "postprocess": id},
    {"name": "value", "symbols": ["floatValue"], "postprocess": id},
    {"name": "value", "symbols": ["intValue"], "postprocess": id},
    {"name": "value", "symbols": ["stringValue"], "postprocess": id},
    {"name": "value", "symbols": ["booleanValue"], "postprocess": id},
    {"name": "value", "symbols": ["nullValue"], "postprocess": id},
    {"name": "value", "symbols": ["listValue"], "postprocess": id},
    {"name": "value", "symbols": ["objectValue"], "postprocess": id},
    {"name": "value", "symbols": ["enumValue"], "postprocess": id},
    {"name": "booleanValue", "symbols": [(lexer.has("kwtrue") ? {type: "kwtrue"} : kwtrue)], "postprocess": function() { return true }},
    {"name": "booleanValue", "symbols": [(lexer.has("kwfalse") ? {type: "kwfalse"} : kwfalse)], "postprocess": function() { return false }},
    {"name": "nullValue", "symbols": [(lexer.has("kwnull") ? {type: "kwnull"} : kwnull)], "postprocess": function() { return null }},
    {"name": "enumValue", "symbols": [(lexer.has("name") ? {type: "name"} : name)], "postprocess":  function(d) {
          const n = nameOf(d[0])
          if (n === 'true' || n === 'false' || n === 'null') throw new Error('invalid EnumValue')
          return { kind: 'EnumValue', value: n }
        } },
    {"name": "intValue", "symbols": [(lexer.has("int") ? {type: "int"} : int)], "postprocess": function(d) { return parseInt(d[0].value, 10) }},
    {"name": "floatValue", "symbols": [(lexer.has("float") ? {type: "float"} : float)], "postprocess": function(d) { return parseFloat(d[0].value) }},
    {"name": "stringValue", "symbols": [(lexer.has("blockString") ? {type: "blockString"} : blockString)], "postprocess": function(d) { return parseBlockString(d[0]) }},
    {"name": "stringValue", "symbols": [(lexer.has("string") ? {type: "string"} : string)], "postprocess": function(d) { return parseString(d[0]) }},
    {"name": "listValue", "symbols": [(lexer.has("lbracket") ? {type: "lbracket"} : lbracket), (lexer.has("rbracket") ? {type: "rbracket"} : rbracket)], "postprocess": function() { return [] }},
    {"name": "listValue$ebnf$1", "symbols": []},
    {"name": "listValue$ebnf$1$subexpression$1", "symbols": ["value"]},
    {"name": "listValue$ebnf$1", "symbols": ["listValue$ebnf$1", "listValue$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "listValue", "symbols": [(lexer.has("lbracket") ? {type: "lbracket"} : lbracket), "value", "listValue$ebnf$1", (lexer.has("rbracket") ? {type: "rbracket"} : rbracket)], "postprocess": extractList},
    {"name": "objectValue", "symbols": [(lexer.has("lbrace") ? {type: "lbrace"} : lbrace), (lexer.has("rbrace") ? {type: "rbrace"} : rbrace)], "postprocess": function() { return Object.fromEntries([]) }},
    {"name": "objectValue$ebnf$1", "symbols": []},
    {"name": "objectValue$ebnf$1$subexpression$1", "symbols": ["objectField"]},
    {"name": "objectValue$ebnf$1", "symbols": ["objectValue$ebnf$1", "objectValue$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "objectValue", "symbols": [(lexer.has("lbrace") ? {type: "lbrace"} : lbrace), "objectField", "objectValue$ebnf$1", (lexer.has("rbrace") ? {type: "rbrace"} : rbrace)], "postprocess": function(d) { return Object.fromEntries(extractObjectFields(d)) }},
    {"name": "objectField", "symbols": [(lexer.has("name") ? {type: "name"} : name), (lexer.has("colon") ? {type: "colon"} : colon), "value"], "postprocess": function(d) { return [nameOf(d[0]), d[2]] }},
    {"name": "variableDefinitionsOpt", "symbols": ["variableDefinitions"], "postprocess": id},
    {"name": "variableDefinitionsOpt", "symbols": [], "postprocess": function() { return null }},
    {"name": "selectionSetOpt", "symbols": ["selectionSet"], "postprocess": id},
    {"name": "selectionSetOpt", "symbols": [], "postprocess": function() { return null }}
]
  , ParserStart: "document"
}
if (typeof module !== 'undefined'&& typeof module.exports !== 'undefined') {
   module.exports = grammar;
} else {
   window.grammar = grammar;
}
})();
