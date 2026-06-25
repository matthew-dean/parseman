# GraphQL query document parser (executable definitions only).
# Ported from bench/graphql.pegjs — commas are insignificant whitespace.

@{%
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

%}

@lexer lexer

document -> definition:+ {% function(d) { return d[0] } %}

definition -> operationDefinition {% id %}
  | fragmentDefinition {% id %}

operationDefinition -> selectionSet {% id %}
  | operationType namedOperation {%
    function(d) {
      return {
        operation: d[0],
        name: d[1].name,
        variables: d[1].variables,
        directives: d[1].directives,
        selectionSet: d[1].selectionSet,
      }
    }
  %}

namedOperation -> %name variableDefinitionsOpt directivesOpt selectionSet {%
  function(d) {
    return {
      name: nameOf(d[0]),
      variables: d[1] || [],
      directives: d[2] || [],
      selectionSet: d[3],
    }
  }
%}
  | variableDefinitionsOpt directivesOpt selectionSet {%
  function(d) {
    return {
      name: null,
      variables: d[0] || [],
      directives: d[1] || [],
      selectionSet: d[2],
    }
  }
%}

operationType -> %query {% function() { return 'query' } %}
  | %mutation {% function() { return 'mutation' } %}
  | %subscription {% function() { return 'subscription' } %}

variableDefinitions -> %lparen variableDefinition:+ %rparen {% function(d) { return d[1] } %}

variableDefinition -> variable %colon type defaultValueOpt {% function(d) {
  return { variable: d[0], type: d[2], defaultValue: d[3] }
} %}

variable -> %dollar %name {% function(d) { return { kind: 'Variable', name: nameOf(d[1]) } } %}

defaultValue -> %equals value {% function(d) { return d[1] } %}

defaultValueOpt -> defaultValue {% id %}
  | null {% function() { return null } %}

selectionSet -> %lbrace selection:+ %rbrace {% function(d) { return d[1] } %}

selection -> fragmentSpread {% id %}
  | inlineFragment {% id %}
  | field {% id %}

field -> fieldAliasOpt %name argumentsOpt directivesOpt selectionSetOpt {%
  function(d) {
    return {
      alias: d[0],
      name: nameOf(d[1]),
      arguments: d[2] || [],
      directives: d[3] || [],
      selectionSet: d[4],
    }
  }
%}

fieldAliasOpt -> %name %colon {% function(d) { return nameOf(d[0]) } %}
  | null {% function() { return null } %}

arguments -> %lparen argument:+ %rparen {% function(d) { return d[1] } %}

argumentsOpt -> arguments {% id %}
  | null {% function() { return null } %}

argument -> %name %colon value {% function(d) { return { name: nameOf(d[0]), value: d[2] } } %}

fragmentSpread -> %spread fragmentName directivesOpt {%
  function(d) { return { kind: 'FragmentSpread', name: d[1], directives: d[2] || [] } }
%}

inlineFragment -> %spread typeConditionOpt directivesOpt selectionSet {%
  function(d) {
    return {
      kind: 'InlineFragment',
      typeCondition: d[1],
      directives: d[2] || [],
      selectionSet: d[3],
    }
  }
%}

fragmentDefinition -> %fragment fragmentName typeCondition directivesOpt selectionSet {%
  function(d) {
    return {
      kind: 'FragmentDefinition',
      name: d[1],
      typeCondition: d[2],
      directives: d[3] || [],
      selectionSet: d[4],
    }
  }
%}

fragmentName -> %name {% function(d) { return fragmentNameOf(d[0]) } %}

typeCondition -> %kwon %name {% function(d) { return nameOf(d[1]) } %}

typeConditionOpt -> typeCondition {% id %}
  | null {% function() { return null } %}

directives -> directive:+ {% id %}

directivesOpt -> directives {% id %}
  | null {% function() { return null } %}

directive -> %at %name argumentsOpt {% function(d) {
  return { name: nameOf(d[1]), arguments: d[2] || [] }
} %}

type -> listType nonNullOpt {% function(d) { return d[1] ? { kind: 'NonNull', type: d[0] } : d[0] } %}
  | namedType nonNullOpt {% function(d) { return d[1] ? { kind: 'NonNull', type: d[0] } : d[0] } %}

nonNullOpt -> %bang {% function() { return true } %}
  | null {% function() { return false } %}

namedType -> %name {% function(d) { return { kind: 'NamedType', name: nameOf(d[0]) } } %}

listType -> %lbracket type %rbracket {% function(d) { return { kind: 'ListType', type: d[1] } } %}

value -> variable {% id %}
  | floatValue {% id %}
  | intValue {% id %}
  | stringValue {% id %}
  | booleanValue {% id %}
  | nullValue {% id %}
  | listValue {% id %}
  | objectValue {% id %}
  | enumValue {% id %}

booleanValue -> %kwtrue {% function() { return true } %}
  | %kwfalse {% function() { return false } %}

nullValue -> %kwnull {% function() { return null } %}

enumValue -> %name {% function(d) {
  const n = nameOf(d[0])
  if (n === 'true' || n === 'false' || n === 'null') throw new Error('invalid EnumValue')
  return { kind: 'EnumValue', value: n }
} %}

intValue -> %int {% function(d) { return parseInt(d[0].value, 10) } %}

floatValue -> %float {% function(d) { return parseFloat(d[0].value) } %}

stringValue -> %blockString {% function(d) { return parseBlockString(d[0]) } %}
  | %string {% function(d) { return parseString(d[0]) } %}

listValue -> %lbracket %rbracket {% function() { return [] } %}
  | %lbracket value (value):* %rbracket {% extractList %}

objectValue -> %lbrace %rbrace {% function() { return Object.fromEntries([]) } %}
  | %lbrace objectField (objectField):* %rbrace {% function(d) { return Object.fromEntries(extractObjectFields(d)) } %}

objectField -> %name %colon value {% function(d) { return [nameOf(d[0]), d[2]] } %}

variableDefinitionsOpt -> variableDefinitions {% id %}
  | null {% function() { return null } %}

selectionSetOpt -> selectionSet {% id %}
  | null {% function() { return null } %}
