/**
 * GraphQL query document parser (executable definitions only).
 * Ported from bench/graphql.pegjs — commas are insignificant whitespace.
 */
exports.grammar = {
  comment: 'GraphQL parser — builds JS values matching Peggy bench/graphql.pegjs output.',
  moduleInclude: `
function parseBlockString(s) {
  var chars = [];
  for (var i = 3; i < s.length - 3; ) {
    if (s[i] === '\\\\' && s.slice(i, i + 4) === '\\\\"""') {
      chars.push('\\\\', '"', '"', '"');
      i += 4;
    } else if (s.slice(i, i + 3) === '"""') {
      break;
    } else {
      chars.push(s[i]);
      i++;
    }
  }
  return chars.join('');
}
`,
  lex: {
    macros: {
      name: '[_A-Za-z][_0-9A-Za-z]*',
      ws: '(?:[ \\t\\r\\n,]|#[^\\n\\r]*)+',
    },
    rules: [
      ['{ws}', '/* skip */'],
      ['\\.\\.\\.', "return 'SPREAD';"],
      ['\\{', "return 'LBRACE';"],
      ['\\}', "return 'RBRACE';"],
      ['\\(', "return 'LPAREN';"],
      ['\\)', "return 'RPAREN';"],
      ['\\[', "return 'LBRACKET';"],
      ['\\]', "return 'RBRACKET';"],
      [':', "return 'COLON';"],
      ['!', "return 'BANG';"],
      ['@', "return 'AT';"],
      ['\\$', "return 'DOLLAR';"],
      ['=', "return 'EQUALS';"],
      ['query(?![_0-9A-Za-z])', "return 'QUERY';"],
      ['mutation(?![_0-9A-Za-z])', "return 'MUTATION';"],
      ['subscription(?![_0-9A-Za-z])', "return 'SUBSCRIPTION';"],
      ['fragment(?![_0-9A-Za-z])', "return 'FRAGMENT';"],
      ['on(?![_0-9A-Za-z])', "return 'ON';"],
      ['true(?![_0-9A-Za-z])', "return 'TRUE';"],
      ['false(?![_0-9A-Za-z])', "return 'FALSE';"],
      ['null(?![_0-9A-Za-z])', "return 'NULL';"],
      ['"""(?:\\\\"""|[^])*?"""', "return 'BLOCK_STRING';"],
      ['"(?:\\\\["\\\\bfnrt/\\\\]|\\\\u[a-fA-F0-9]{4}|[^"\\\\])*"', 'yytext = JSON.parse(yytext); return \'STRING\';'],
      ['-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+(?:[eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)', "return 'FLOAT';"],
      ['-?(?:0|[1-9][0-9]*)', "return 'INT';"],
      ['{name}', "return 'NAME';"],
    ],
  },


  tokens:
    'SPREAD LBRACE RBRACE LPAREN RPAREN LBRACKET RBRACKET COLON BANG AT DOLLAR EQUALS ' +
    'QUERY MUTATION SUBSCRIPTION FRAGMENT ON TRUE FALSE NULL ' +
    'BLOCK_STRING STRING FLOAT INT NAME',
  start: 'Document',

  bnf: {
    Document: [['DefinitionList', '$$ = $1']],

    DefinitionList: [
      ['Definition', '$$ = [$1]'],
      ['DefinitionList Definition', '$$ = $1.concat([$2])'],
    ],

    Definition: [
      ['OperationDefinition', '$$ = $1'],
      ['FragmentDefinition', '$$ = $1'],
    ],

    OperationDefinition: [
      ['SelectionSet', '$$ = $1'],
      ['OperationType NamedOperation', '$$ = { operation: $1, name: $2.name, variables: $2.variables, directives: $2.directives, selectionSet: $2.selectionSet }'],
    ],

    NamedOperation: [
      ['NAME VariableDefinitionsOpt DirectivesOpt SelectionSet', '$$ = { name: $1, variables: $2 || [], directives: $3 || [], selectionSet: $4 }'],
      ['VariableDefinitionsOpt DirectivesOpt SelectionSet', '$$ = { name: null, variables: $1 || [], directives: $2 || [], selectionSet: $3 }'],
    ],

    OperationType: [
      ['QUERY', '$$ = "query"'],
      ['MUTATION', '$$ = "mutation"'],
      ['SUBSCRIPTION', '$$ = "subscription"'],
    ],

    VariableDefinitionsOpt: [
      ['', '$$ = null'],
      ['VariableDefinitions', '$$ = $1'],
    ],

    VariableDefinitions: [['LPAREN VariableDefinitionList RPAREN', '$$ = $2']],

    VariableDefinitionList: [
      ['VariableDefinition', '$$ = [$1]'],
      ['VariableDefinitionList VariableDefinition', '$$ = $1.concat([$2])'],
    ],

    VariableDefinition: [
      ['Variable COLON Type DefaultValueOpt', '$$ = { variable: $1, type: $3, defaultValue: $4 }'],
    ],

    Variable: [['DOLLAR NAME', '$$ = { kind: "Variable", name: $2 }']],

    DefaultValueOpt: [
      ['', '$$ = null'],
      ['DefaultValue', '$$ = $1'],
    ],

    DefaultValue: [['EQUALS Value', '$$ = $2']],

    SelectionSet: [['LBRACE SelectionList RBRACE', '$$ = $2']],

    SelectionList: [
      ['Selection', '$$ = [$1]'],
      ['SelectionList Selection', '$$ = $1.concat([$2])'],
    ],

    Selection: [
      ['FragmentSpread', '$$ = $1'],
      ['InlineFragment', '$$ = $1'],
      ['Field', '$$ = $1'],
    ],

    Field: [
      ['NAME COLON NAME ArgumentsOpt DirectivesOpt SelectionSet', '$$ = { alias: $1, name: $3, arguments: $4 || [], directives: $5 || [], selectionSet: $6 }'],
      ['NAME COLON NAME ArgumentsOpt DirectivesOpt', '$$ = { alias: $1, name: $3, arguments: $4 || [], directives: $5 || [], selectionSet: null }'],
      ['NAME ArgumentsOpt DirectivesOpt SelectionSet', '$$ = { alias: null, name: $1, arguments: $2 || [], directives: $3 || [], selectionSet: $4 }'],
      ['NAME ArgumentsOpt DirectivesOpt', '$$ = { alias: null, name: $1, arguments: $2 || [], directives: $3 || [], selectionSet: null }'],
    ],

    ArgumentsOpt: [
      ['', '$$ = null'],
      ['Arguments', '$$ = $1'],
    ],

    Arguments: [['LPAREN ArgumentList RPAREN', '$$ = $2']],

    ArgumentList: [
      ['Argument', '$$ = [$1]'],
      ['ArgumentList Argument', '$$ = $1.concat([$2])'],
    ],

    Argument: [['NAME COLON Value', '$$ = { name: $1, value: $3 }']],

    FragmentSpread: [
      ['SPREAD FragmentName DirectivesOpt', '$$ = { kind: "FragmentSpread", name: $2, directives: $3 || [] }'],
    ],

    InlineFragment: [
      ['SPREAD TypeConditionOpt DirectivesOpt SelectionSet', '$$ = { kind: "InlineFragment", typeCondition: $2, directives: $3 || [], selectionSet: $4 }'],
    ],

    FragmentDefinition: [
      ['FRAGMENT FragmentName TypeCondition DirectivesOpt SelectionSet', '$$ = { kind: "FragmentDefinition", name: $2, typeCondition: $3, directives: $4 || [], selectionSet: $5 }'],
    ],

    FragmentName: [['NAME', 'if ($1 === "on") throw new Error(\'FragmentName cannot be "on"\'); $$ = $1']],

    TypeCondition: [['ON NAME', '$$ = $2']],

    TypeConditionOpt: [
      ['', '$$ = null'],
      ['TypeCondition', '$$ = $1'],
    ],

    DirectivesOpt: [
      ['', '$$ = null'],
      ['Directives', '$$ = $1'],
    ],

    Directives: [
      ['Directive', '$$ = [$1]'],
      ['Directives Directive', '$$ = $1.concat([$2])'],
    ],

    Directive: [['AT NAME ArgumentsOpt', '$$ = { name: $2, arguments: $3 || [] }']],

    Type: [
      ['ListType NonNullOpt', '$$ = $2 ? { kind: "NonNull", type: $1 } : $1'],
      ['NamedType NonNullOpt', '$$ = $2 ? { kind: "NonNull", type: $1 } : $1'],
    ],

    NonNullOpt: [
      ['', '$$ = false'],
      ['BANG', '$$ = true'],
    ],

    NamedType: [['NAME', '$$ = { kind: "NamedType", name: $1 }']],

    ListType: [['LBRACKET Type RBRACKET', '$$ = { kind: "ListType", type: $2 }']],

    Value: [
      ['Variable', '$$ = $1'],
      ['FloatValue', '$$ = $1'],
      ['IntValue', '$$ = $1'],
      ['StringValue', '$$ = $1'],
      ['BooleanValue', '$$ = $1'],
      ['NullValue', '$$ = $1'],
      ['ListValue', '$$ = $1'],
      ['ObjectValue', '$$ = $1'],
      ['EnumValue', '$$ = $1'],
    ],

    BooleanValue: [
      ['TRUE', '$$ = true'],
      ['FALSE', '$$ = false'],
    ],

    NullValue: [['NULL', '$$ = null']],

    EnumValue: [['NAME', 'if ($1 === "true" || $1 === "false" || $1 === "null") throw new Error("invalid EnumValue"); $$ = { kind: "EnumValue", value: $1 }']],

    IntValue: [['INT', '$$ = parseInt($1, 10)']],

    FloatValue: [['FLOAT', '$$ = parseFloat($1)']],

    StringValue: [
      ['BLOCK_STRING', '$$ = parseBlockString(yytext)'],
      ['STRING', '$$ = $1'],
    ],

    ListValue: [
      ['LBRACKET RBRACKET', '$$ = []'],
      ['LBRACKET ValueList RBRACKET', '$$ = $2'],
    ],

    ValueList: [
      ['Value', '$$ = [$1]'],
      ['ValueList Value', '$$ = $1.concat([$2])'],
    ],

    ObjectValue: [
      ['LBRACE RBRACE', '$$ = Object.fromEntries([])'],
      ['LBRACE ObjectFieldList RBRACE', '$$ = Object.fromEntries($2)'],
    ],

    ObjectFieldList: [
      ['ObjectField', '$$ = [$1]'],
      ['ObjectFieldList ObjectField', '$$ = $1.concat([$2])'],
    ],

    ObjectField: [['NAME COLON Value', '$$ = [$1, $3]']],
  },
}
