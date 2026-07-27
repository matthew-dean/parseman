/**
 * GraphQL query document parser built with Parséman.
 *
 * Parses executable GraphQL documents per the October 2021 spec:
 *   https://spec.graphql.org/October2021/
 *
 * Covers: operations (query/mutation/subscription + shorthand), field
 * selections, aliases, arguments, variables, directives, fragments,
 * inline fragments, all value types. Does NOT cover type system definitions.
 *
 * Whitespace handling: commas and line comments are insignificant in GraphQL.
 * We define a trivia combinator that skips all of them uniformly.
 */
import {
  literal, regex, sequence, choice, optional, many, oneOrMore,
  transform, trivia, parser, rules, makeWord, keywords,
  type Combinator,
} from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Trivia — whitespace, commas, line comments (all insignificant per spec)
// ---------------------------------------------------------------------------
export const ws = trivia(regex(/(?:[ \t\n\r,]|#[^\n\r]*)*/))

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------
const name = regex(/[_A-Za-z][_0-9A-Za-z]*/)

/** GraphQL Name boundary — same as spec ident charset. */
const kw = makeWord('_0-9A-Za-z')

const intValue = transform(regex(/-?(?:0|[1-9]\d*)/), s => parseInt(s, 10))
const floatValue = transform(
  regex(/-?(?:0|[1-9]\d*)(?:\.\d+(?:[eE][+-]?\d+)?|[eE][+-]?\d+)/),
  parseFloat,
)
const stringInner = regex(/(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*/)
const stringValue = transform(
  sequence(literal('"'), stringInner, literal('"')),
  ([, s]) => s
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\//g, '/')
    .replace(/\\b/g, '\b').replace(/\\f/g, '\f').replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
)
const boolValue = transform(choice(kw('true'), kw('false')), s => s === 'true')
const nullValue = transform(kw('null'), () => null)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type GQLType =
  | { kind: 'NamedType'; name: string }
  | { kind: 'ListType'; type: GQLType }
  | { kind: 'NonNull'; type: GQLType }

const { gqlType } = rules<{ gqlType: Combinator<GQLType> }>(g => {
  const namedType = transform(name, n => ({ kind: 'NamedType' as const, name: n }))
  const listType = transform(
    sequence(literal('['), g.gqlType as Combinator<GQLType>, literal(']')),
    ([, t]) => ({ kind: 'ListType' as const, type: t }),
  )
  return {
    gqlType: transform(
      sequence(choice(listType, namedType), optional(literal('!'))),
      ([t, bang]) => bang ? { kind: 'NonNull' as const, type: t } : t,
    ),
  }
})

// ---------------------------------------------------------------------------
// Values (recursive)
// ---------------------------------------------------------------------------
export type GQLScalar = number | string | boolean | null
export type GQLObject =
  | { kind: 'Variable'; name: string }
  | { kind: 'EnumValue'; value: string }
export interface GQLArray extends ReadonlyArray<GQLValue> {}
export interface GQLRecord extends Readonly<Record<string, GQLValue>> {}
export type GQLValue = GQLScalar | GQLObject | GQLArray | GQLRecord

const { gqlValue } = rules<{ gqlValue: Combinator<GQLValue> }>(g => {
  const variable = transform(
    sequence(literal('$'), name),
    ([, n]) => ({ kind: 'Variable' as const, name: n }),
  )
  const listVal = transform(
    sequence(literal('['), many(g.gqlValue as Combinator<GQLValue>), literal(']')),
    ([, items]) => items,
  )
  const objectField = transform(
    sequence(name, literal(':'), g.gqlValue as Combinator<GQLValue>),
    ([k,, v]) => [k, v] as [string, GQLValue],
  )
  const objectVal = transform(
    sequence(literal('{'), many(objectField), literal('}')),
    ([, fields]) => Object.fromEntries(fields),
  )
  const enumVal = transform(name, n => ({ kind: 'EnumValue' as const, value: n }))
  return {
    gqlValue: choice(
      variable, floatValue, intValue, stringValue,
      boolValue as Combinator<GQLValue>,
      nullValue as Combinator<GQLValue>,
      listVal, objectVal, enumVal,
    ) as Combinator<GQLValue>,
  }
})

// ---------------------------------------------------------------------------
// Arguments & Directives
// ---------------------------------------------------------------------------
type GQLArg       = { name: string; value: GQLValue }
type GQLDirective = { name: string; arguments: GQLArg[] }

const argument: Combinator<GQLArg> = transform(
  sequence(name, literal(':'), gqlValue),
  ([n,, v]) => ({ name: n, value: v }),
)
const arguments_ = transform(
  sequence(literal('('), oneOrMore(argument), literal(')')),
  ([, args]) => args,
)
const directive: Combinator<GQLDirective> = transform(
  sequence(literal('@'), name, optional(arguments_)),
  ([, n, args]) => ({ name: n, arguments: args ?? [] }),
)
const directives = oneOrMore(directive)

// ---------------------------------------------------------------------------
// Variable definitions
// ---------------------------------------------------------------------------
type GQLVarDef = { variable: string; type: GQLType; defaultValue: GQLValue | null }

const variableDefinition: Combinator<GQLVarDef> = transform(
  sequence(literal('$'), name, literal(':'), gqlType, optional(sequence(literal('='), gqlValue))),
  ([, n,, t, def]) => ({ variable: n, type: t, defaultValue: def ? def[1] : null }),
)
const variableDefinitions = transform(
  sequence(literal('('), oneOrMore(variableDefinition), literal(')')),
  ([, defs]) => defs,
)

// ---------------------------------------------------------------------------
// Selections (recursive)
// ---------------------------------------------------------------------------
export type GQLField = {
  alias: string | null; name: string
  arguments: GQLArg[]; directives: GQLDirective[]
  selectionSet: GQLSelection[] | null
}
export type GQLFragmentSpread = { kind: 'FragmentSpread'; name: string; directives: GQLDirective[] }
export type GQLInlineFragment = { kind: 'InlineFragment'; typeCondition: string | null; directives: GQLDirective[]; selectionSet: GQLSelection[] }
export type GQLSelection      = GQLField | GQLFragmentSpread | GQLInlineFragment

const { selection, selectionSet } = rules<{
  selection:    Combinator<GQLSelection>
  selectionSet: Combinator<GQLSelection[]>
}>(g => {
  const field: Combinator<GQLField> = transform(
    sequence(
      optional(transform(sequence(name, literal(':')), ([n]) => n)),
      name,
      optional(arguments_),
      optional(directives),
      optional(g.selectionSet as Combinator<GQLSelection[]>),
    ),
    ([aliasValue, n, args, dirs, sel]) => ({
      alias: aliasValue ?? null, name: n,
      arguments: args ?? [], directives: dirs ?? [],
      selectionSet: sel ?? null,
    }),
  )
  const fragmentSpread: Combinator<GQLFragmentSpread> = transform(
    sequence(literal('...'), regex(/[_A-Za-z][_0-9A-Za-z]*/), optional(directives)),
    ([, n, dirs]) => ({ kind: 'FragmentSpread' as const, name: n, directives: dirs ?? [] }),
  )
  const inlineFragment: Combinator<GQLInlineFragment> = transform(
    sequence(
      literal('...'),
      optional(transform(sequence(kw('on'), name), ([, n]) => n)),
      optional(directives),
      g.selectionSet as Combinator<GQLSelection[]>,
    ),
    ([, cond, dirs, sel]) => ({
      kind: 'InlineFragment' as const,
      typeCondition: cond ?? null,
      directives: dirs ?? [],
      selectionSet: sel,
    }),
  )
  return {
    selection: choice(fragmentSpread, inlineFragment, field),
    selectionSet: transform(
      sequence(literal('{'), oneOrMore(g.selection as Combinator<GQLSelection>), literal('}')),
      ([, sels]) => sels,
    ),
  }
})

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------
export type GQLOperationType = 'query' | 'mutation' | 'subscription'
export type GQLOperationDef  = {
  kind: 'OperationDefinition'; operation: GQLOperationType; name: string | null
  variables: GQLVarDef[]; directives: GQLDirective[]; selectionSet: GQLSelection[]
}
export type GQLFragmentDef = {
  kind: 'FragmentDefinition'; name: string; typeCondition: string
  directives: GQLDirective[]; selectionSet: GQLSelection[]
}
export type GQLDefinition = GQLOperationDef | GQLFragmentDef

const operationType = keywords(
  ['query', 'mutation', 'subscription'],
  { boundary: '_0-9A-Za-z' },
) as Combinator<GQLOperationType>

const operationDefinition: Combinator<GQLOperationDef> = choice(
  transform(selectionSet, sel => ({
    kind: 'OperationDefinition' as const, operation: 'query' as const,
    name: null, variables: [], directives: [], selectionSet: sel,
  })),
  transform(
    sequence(operationType, optional(name), optional(variableDefinitions), optional(directives), selectionSet),
    ([op, n, vars, dirs, sel]) => ({
      kind: 'OperationDefinition' as const, operation: op,
      name: n ?? null, variables: vars ?? [], directives: dirs ?? [], selectionSet: sel,
    }),
  ),
)

const fragmentDefinition: Combinator<GQLFragmentDef> = transform(
  sequence(kw('fragment'), regex(/[_A-Za-z][_0-9A-Za-z]*/), kw('on'), name, optional(directives), selectionSet),
  ([, n,, cond, dirs, sel]) => ({
    kind: 'FragmentDefinition' as const, name: n, typeCondition: cond,
    directives: dirs ?? [], selectionSet: sel,
  }),
)

const definition: Combinator<GQLDefinition> = choice(operationDefinition, fragmentDefinition)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const graphqlDoc = parser({ trivia: ws }, oneOrMore(definition))

export function parseGraphQL(input: string): GQLDefinition[] {
  const result = graphqlDoc.parse(input)
  if (!result.ok) {
    throw new SyntaxError(
      `GraphQL parse error at offset ${result.span.start}: expected ${result.expected.join(' or ')}`,
    )
  }
  return result.value
}
