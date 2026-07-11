/**
 * Parsimmon GraphQL query document parser for benchmark comparison.
 * Parses executable GraphQL documents (operations + fragments).
 */
import P from 'parsimmon'

// Insignificant: whitespace, commas, line comments
const _ = P.regexp(/(?:[ \t\n\r,]|#[^\n\r]*)*/)

const Name = P.regexp(/[_A-Za-z][_0-9A-Za-z]*/)

// Keywords that must not be followed by more name chars
function kw(word: string) {
  return P.regexp(new RegExp(word + '(?![_0-9A-Za-z])')).trim(_)
}

const GQL: P.Language = P.createLanguage({
  Document: r => r.Definition.trim(_).atLeast(1),

  Definition: r => P.alt(r.OperationDefinition, r.FragmentDefinition),

  OperationDefinition: r =>
    P.alt(
      r.SelectionSet.map(selectionSet =>
        ({ kind: 'OperationDefinition', operation: 'query', name: null, variables: [], directives: [], selectionSet })),
      P.seqMap(
        r.OperationType, r.Name.trim(_).fallback(null),
        r.VariableDefinitions.fallback([]),
        r.Directives.fallback([]),
        r.SelectionSet,
        (operation, name, variables, directives, selectionSet) =>
          ({ kind: 'OperationDefinition', operation, name, variables, directives, selectionSet }),
      ),
    ),

  OperationType: () =>
    P.alt(kw('query'), kw('mutation'), kw('subscription')),

  VariableDefinitions: r =>
    r.VariableDefinition.trim(_).atLeast(1).wrap(P.string('(').trim(_), P.string(')').trim(_)),

  VariableDefinition: r =>
    P.seqMap(P.string('$').then(r.Name.trim(_)), P.string(':').trim(_), r.Type, r.DefaultValue.fallback(null),
      (variable, _, type, defaultValue) => ({ variable, type, defaultValue })),

  Variable: r =>
    P.string('$').then(r.Name.trim(_)).map(name => ({ kind: 'Variable', name })),

  DefaultValue: r => P.string('=').trim(_).then(r.Value),

  SelectionSet: r =>
    r.Selection.trim(_).atLeast(1).wrap(P.string('{').trim(_), P.string('}').trim(_)),

  Selection: r => P.alt(r.FragmentSpread, r.InlineFragment, r.Field),

  Field: r =>
    P.seqMap(
      P.seqMap(r.Name, P.string(':').trim(_), (alias, _) => alias).fallback(null),
      r.Name.trim(_),
      r.Arguments.fallback([]),
      r.Directives.fallback([]),
      r.SelectionSet.fallback(null),
      (alias, name, args, directives, selectionSet) =>
        ({ alias, name, arguments: args, directives, selectionSet }),
    ),

  Arguments: r =>
    r.Argument.trim(_).atLeast(1).wrap(P.string('(').trim(_), P.string(')').trim(_)),

  Argument: r =>
    P.seqMap(r.Name, P.string(':').trim(_), r.Value,
      (name, _, value) => ({ name, value })),

  FragmentSpread: r =>
    P.string('...').trim(_).then(
      P.seqMap(r.FragmentName, r.Directives.fallback([]),
        (name, directives) => ({ kind: 'FragmentSpread', name, directives }))),

  InlineFragment: r =>
    P.string('...').trim(_).then(
      P.seqMap(r.TypeCondition.fallback(null), r.Directives.fallback([]), r.SelectionSet,
        (typeCondition, directives, selectionSet) =>
          ({ kind: 'InlineFragment', typeCondition, directives, selectionSet }))),

  FragmentDefinition: r =>
    P.seqMap(
      kw('fragment'), r.FragmentName, r.TypeCondition, r.Directives.fallback([]), r.SelectionSet,
      (_kw, name, typeCondition, directives, selectionSet) =>
        ({ kind: 'FragmentDefinition', name, typeCondition, directives, selectionSet })),

  FragmentName: r =>
    P.custom((success, failure) => (stream, i) => {
      const m = /[_A-Za-z][_0-9A-Za-z]*/.exec(stream.slice(i))
      if (!m) return failure(i, 'FragmentName')
      if (m[0] === 'on') return failure(i, 'FragmentName (not "on")')
      return success(i + m[0].length, m[0])
    }),

  TypeCondition: r => kw('on').then(r.Name.trim(_)),

  Directives: r => r.Directive.trim(_).atLeast(1),

  Directive: r =>
    P.string('@').then(
      P.seqMap(r.Name.trim(_), r.Arguments.fallback([]),
        (name, args) => ({ name, arguments: args }))),

  Type: r =>
    P.seqMap(
      P.alt(
        r.Name.trim(_).map(name => ({ kind: 'NamedType', name })),
        r.Type.wrap(P.string('[').trim(_), P.string(']').trim(_)).map(t => ({ kind: 'ListType', type: t })),
      ),
      P.string('!').fallback(null),
      (t, nn) => nn ? { kind: 'NonNull', type: t } : t,
    ),

  Value: r =>
    P.alt(
      r.Variable,
      P.regexp(/-?(?:0|[1-9]\d*)(?:\.\d+)([eE][+-]?\d+)?|(?:-?(?:0|[1-9]\d*)(?:[eE][+-]?\d+))/)
        .map(parseFloat),
      P.regexp(/-?(?:0|[1-9]\d*)/).map(s => parseInt(s, 10)),
      r.StringValue,
      kw('true').result(true),
      kw('false').result(false),
      kw('null').result(null),
      r.Value.trim(_).many().wrap(P.string('[').trim(_), P.string(']').trim(_)),
      P.seqMap(r.Name, P.string(':').trim(_), r.Value,
        (k, _, v) => [k, v] as [string, unknown])
        .trim(_).many()
        .wrap(P.string('{').trim(_), P.string('}').trim(_))
        .map(Object.fromEntries),
      r.Name.map(name => ({ kind: 'EnumValue', value: name })),
    ),

  StringValue: () =>
    P.regexp(/"""[\s\S]*?"""|"(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/)
      .map(s => s.startsWith('"""')
        ? s.slice(3, -3)
        : s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\/g, '')),

  Name: () => Name.trim(_),
})

export function buildParsimmonGraphQL(): (input: string) => unknown {
  return (input: string) => GQL.Document.tryParse(input)
}
