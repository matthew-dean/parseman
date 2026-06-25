/**
 * JSON grammar with value-building semantic actions.
 * Based on zaach/jison examples/json.js (ECMA-262) + Peggy bench/json.pegjs output shape.
 */
exports.grammar = {
  comment: 'JSON parser — builds JS values (Object.create(null) objects, arrays, primitives).',
  lex: {
    macros: {
      digit: '[0-9]',
      esc: '\\\\',
      int: '-?(?:[0-9]|[1-9][0-9]+)',
      exp: '(?:[eE][-+]?[0-9]+)',
      frac: '(?:\\.[0-9]+)',
    },
    rules: [
      ['\\s+', '/* skip whitespace */'],
      ['{int}{frac}?{exp}?\\b', "return 'NUMBER';"],
      [
        '"(?:{esc}["bfnrt/{esc}]|{esc}u[a-fA-F0-9]{4}|[^"{esc}])*"',
        'yytext = yytext.substr(1,yyleng-2); return \'STRING\';',
      ],
      ['\\{', "return '{'"],
      ['\\}', "return '}'"],
      ['\\[', "return '['"],
      ['\\]', "return ']'"],
      [',', "return ','"],
      [':', "return ':'"],
      ['true\\b', "return 'TRUE'"],
      ['false\\b', "return 'FALSE'"],
      ['null\\b', "return 'NULL'"],
    ],
  },

  tokens: 'STRING NUMBER { } [ ] , : TRUE FALSE NULL',
  start: 'JSONText',

  bnf: {
    JSONText: [['JSONValue', '$$ = $1']],

    JSONString: [['STRING', '$$ = JSON.parse("\\"" + $1 + "\\"")']],

    JSONNullLiteral: [['NULL', '$$ = null']],

    JSONNumber: [['NUMBER', '$$ = parseFloat($1)']],

    JSONBooleanLiteral: [
      ['TRUE', '$$ = true'],
      ['FALSE', '$$ = false'],
    ],

    JSONValue: [
      ['JSONNullLiteral', '$$ = $1'],
      ['JSONBooleanLiteral', '$$ = $1'],
      ['JSONString', '$$ = $1'],
      ['JSONNumber', '$$ = $1'],
      ['JSONObject', '$$ = $1'],
      ['JSONArray', '$$ = $1'],
    ],

    JSONObject: [
      ['{ }', '$$ = Object.create(null)'],
      ['{ JSONMemberList }', '$$ = $2'],
    ],

    JSONMember: [['JSONString : JSONValue', '$$ = [$1, $3]']],

    JSONMemberList: [
      ['JSONMember', '$$ = Object.create(null); $$[$1[0]] = $1[1];'],
      ['JSONMemberList , JSONMember', '$$[$3[0]] = $3[1];'],
    ],

    JSONArray: [
      ['[ ]', '$$ = []'],
      ['[ JSONElementList ]', '$$ = $2'],
    ],

    JSONElementList: [
      ['JSONValue', '$$ = [$1]'],
      ['JSONElementList , JSONValue', '$$ = $1.concat([$3])'],
    ],
  },
}
