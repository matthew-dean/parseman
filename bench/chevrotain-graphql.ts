/**
 * Chevrotain GraphQL executable-document parser for benchmark comparison.
 *
 * Builds the SAME value AST the other bench parsers produce (matching
 * examples/graphql/parser.ts), via `EmbeddedActionsParser` — NOT a CST. This
 * keeps the comparison apples-to-apples: every parser here does the equivalent
 * "recognize + build a plain-object AST" work, so Chevrotain isn't penalised by
 * an extra CST-construction/traversal pass. See bench/PARITY.md.
 */
import { createToken, Lexer, EmbeddedActionsParser, type IOrAlt } from 'chevrotain'
import XRegExp from 'xregexp'

// ---------------------------------------------------------------------------
// Tokens — declared in precedence order (longer_alt before Name)
// ---------------------------------------------------------------------------
const WhiteSpace     = createToken({ name: 'WhiteSpace',     pattern: /[ \t]+/,    group: Lexer.SKIPPED })
const LineTerminator = createToken({ name: 'LineTerminator', pattern: /\n\r|\r|\n/, group: Lexer.SKIPPED })
const Comment        = createToken({ name: 'Comment',        pattern: /#[^\n\r]*/,  group: Lexer.SKIPPED })
const Comma          = createToken({ name: 'Comma',          pattern: ',',          group: Lexer.SKIPPED })

const Name = createToken({ name: 'Name', pattern: /[_A-Za-z][_0-9A-Za-z]*/ })

function keyword(word: string) {
  const cap = word[0]!.toUpperCase() + word.slice(1)
  return createToken({ name: cap, pattern: new RegExp(word), longer_alt: Name })
}

const Query        = keyword('query')
const Mutation     = keyword('mutation')
const Subscription = keyword('subscription')
const Fragment     = keyword('fragment')
const On           = keyword('on')
const True         = keyword('true')
const False        = keyword('false')
const Null         = keyword('null')

const Exclamation = createToken({ name: 'Exclamation', pattern: '!' })
const Dollar      = createToken({ name: 'Dollar',      pattern: '$' })
const LParen      = createToken({ name: 'LParen',      pattern: '(' })
const RParen      = createToken({ name: 'RParen',      pattern: ')' })
const DotDotDot   = createToken({ name: 'DotDotDot',   pattern: '...' })
const Colon       = createToken({ name: 'Colon',       pattern: ':' })
const Equals      = createToken({ name: 'Equals',      pattern: '=' })
const At          = createToken({ name: 'At',          pattern: '@' })
const LSquare     = createToken({ name: 'LSquare',     pattern: '[' })
const RSquare     = createToken({ name: 'RSquare',     pattern: ']' })
const LCurly      = createToken({ name: 'LCurly',      pattern: '{' })
const RCurly      = createToken({ name: 'RCurly',      pattern: '}' })

const frags: Record<string, RegExp> = {}
function F(k: string, v: string) { frags[k] = XRegExp.build(v, frags) }
function P(v: string) { return XRegExp.build(v, frags) }
F('IntPart',   '-?(0|[1-9][0-9]*)')
F('FracPart',  '\\.[0-9]+')
F('ExpPart',   '[eE][+-]?[0-9]+')
F('StrChar',   '(?:[^\\\\"\\n\\r]|\\\\(?:["\\\\\\/bfnrt]|u[0-9a-fA-F]{4}))')
F('BlockChar', '\\\\"""|[^"]|"(?!"")')
const IntValue    = createToken({ name: 'IntValue',    pattern: P('{{IntPart}}') })
const FloatValue  = createToken({ name: 'FloatValue',  pattern: P('{{IntPart}}{{FracPart}}({{ExpPart}})?|{{IntPart}}{{ExpPart}}') })
const StringValue = createToken({ name: 'StringValue', pattern: P('"""(?:{{BlockChar}})*"""|"(?:{{StrChar}})*"') })

const allTokens = [
  WhiteSpace, LineTerminator, Comment, Comma,
  Query, Mutation, Subscription, Fragment, On, True, False, Null,
  DotDotDot, Exclamation, Dollar, LParen, RParen, Colon, Equals,
  At, LSquare, RSquare, LCurly, RCurly,
  FloatValue, IntValue, StringValue, Name,
]

const GraphQLLexer = new Lexer(allTokens)

// ---------------------------------------------------------------------------
// AST value types (mirror examples/graphql/parser.ts)
// ---------------------------------------------------------------------------
type Value = unknown
type Arg = { name: string; value: Value }
type Directive = { name: string; arguments: Arg[] }
type GQLType =
  | { kind: 'NamedType'; name: string }
  | { kind: 'ListType'; type: GQLType }
  | { kind: 'NonNull'; type: GQLType }

/** Unescape a regular `"..."` string body exactly like examples/graphql/parser.ts. */
function unescapeString(raw: string): string {
  if (raw.startsWith('"""')) return raw.slice(3, -3)
  return raw.slice(1, -1)
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\\//g, '/')
    .replace(/\\b/g, '\b').replace(/\\f/g, '\f').replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

// ---------------------------------------------------------------------------
// Parser — builds the value AST directly (no CST)
// ---------------------------------------------------------------------------
class GQLParser extends EmbeddedActionsParser {
  constructor() {
    super(allTokens, { recoveryEnabled: false })
    this.performSelfAnalysis()
  }

  Document = this.RULE('Document', (): unknown[] => {
    const defs: unknown[] = []
    this.AT_LEAST_ONE(() => {
      const d = this.SUBRULE(this.Definition)
      this.ACTION(() => defs.push(d))
    })
    return defs
  })

  private cDefinition?: IOrAlt<unknown>[]
  Definition = this.RULE('Definition', (): unknown =>
    this.OR(this.cDefinition ??= [
      { ALT: () => this.SUBRULE(this.OperationDefinition) },
      { ALT: () => this.SUBRULE(this.FragmentDefinition) },
    ]))

  private cOpDef?: IOrAlt<unknown>[]
  OperationDefinition = this.RULE('OperationDefinition', (): unknown =>
    this.OR(this.cOpDef ??= [
      { ALT: () => {
        const selectionSet = this.SUBRULE(this.SelectionSet)
        return { kind: 'OperationDefinition', operation: 'query', name: null, variables: [], directives: [], selectionSet }
      }},
      { ALT: () => {
        const operation = this.SUBRULE(this.OperationType)
        const name = this.OPTION(() => this.CONSUME(Name).image)
        const variables = this.OPTION2(() => this.SUBRULE(this.VariableDefinitions))
        const directives = this.OPTION3(() => this.SUBRULE(this.Directives))
        const selectionSet = this.SUBRULE2(this.SelectionSet)
        return { kind: 'OperationDefinition', operation, name: name ?? null, variables: variables ?? [], directives: directives ?? [], selectionSet }
      }},
    ]))

  private cOpType?: IOrAlt<string>[]
  OperationType = this.RULE('OperationType', (): string =>
    this.OR(this.cOpType ??= [
      { ALT: () => this.CONSUME(Query).image },
      { ALT: () => this.CONSUME(Mutation).image },
      { ALT: () => this.CONSUME(Subscription).image },
    ]))

  SelectionSet = this.RULE('SelectionSet', (): unknown[] => {
    const sels: unknown[] = []
    this.CONSUME(LCurly)
    this.AT_LEAST_ONE(() => {
      const s = this.SUBRULE(this.Selection)
      this.ACTION(() => sels.push(s))
    })
    this.CONSUME(RCurly)
    return sels
  })

  // OR alternatives arrays are cached (allocated once, not per-invocation) per
  // https://chevrotain.io/docs/guide/performance.html#caching-arrays-of-alternatives
  private cSelection?: IOrAlt<unknown>[]
  Selection = this.RULE('Selection', (): unknown =>
    this.OR(this.cSelection ??= [
      { GATE: () => this.LA(1).tokenType === DotDotDot, ALT: () => this.SUBRULE(this.FragmentLike) },
      { ALT: () => this.SUBRULE(this.Field) },
    ]))

  // FragmentSpread / InlineFragment share the `...` prefix.
  private cFrag?: IOrAlt<unknown>[]
  FragmentLike = this.RULE('FragmentLike', (): unknown => {
    this.CONSUME(DotDotDot)
    return this.OR(this.cFrag ??= [
      // `... FragmentName [directives]` — a spread (name is never the `on` keyword).
      { GATE: () => this.LA(1).tokenType === Name, ALT: () => {
        const name = this.CONSUME(Name).image
        const directives = this.OPTION(() => this.SUBRULE(this.Directives))
        return { kind: 'FragmentSpread', name, directives: directives ?? [] }
      }},
      // `... [on Type] [directives] SelectionSet` — an inline fragment.
      { ALT: () => {
        const typeCondition = this.OPTION2(() => { this.CONSUME(On); return this.CONSUME2(Name).image })
        const directives = this.OPTION3(() => this.SUBRULE2(this.Directives))
        const selectionSet = this.SUBRULE(this.SelectionSet)
        return { kind: 'InlineFragment', typeCondition: typeCondition ?? null, directives: directives ?? [], selectionSet }
      }},
    ] as IOrAlt<unknown>[])
  })

  Field = this.RULE('Field', (): unknown => {
    const alias = this.OPTION({
      GATE: () => this.LA(2).tokenType === Colon,
      DEF: () => { const a = this.CONSUME(Name).image; this.CONSUME(Colon); return a },
    })
    const name = this.CONSUME2(Name).image
    const args = this.OPTION2(() => this.SUBRULE(this.Arguments))
    const directives = this.OPTION3(() => this.SUBRULE(this.Directives))
    const selectionSet = this.OPTION4(() => this.SUBRULE(this.SelectionSet))
    return { alias: alias ?? null, name, arguments: args ?? [], directives: directives ?? [], selectionSet: selectionSet ?? null }
  })

  FragmentDefinition = this.RULE('FragmentDefinition', (): unknown => {
    this.CONSUME(Fragment)
    const name = this.CONSUME(Name).image
    this.CONSUME(On)
    const typeCondition = this.CONSUME2(Name).image
    const directives = this.OPTION(() => this.SUBRULE(this.Directives))
    const selectionSet = this.SUBRULE(this.SelectionSet)
    return { kind: 'FragmentDefinition', name, typeCondition, directives: directives ?? [], selectionSet }
  })

  Arguments = this.RULE('Arguments', (): Arg[] => {
    const args: Arg[] = []
    this.CONSUME(LParen)
    this.AT_LEAST_ONE(() => {
      const a = this.SUBRULE(this.Argument)
      this.ACTION(() => args.push(a))
    })
    this.CONSUME(RParen)
    return args
  })

  Argument = this.RULE('Argument', (): Arg => {
    const name = this.CONSUME(Name).image
    this.CONSUME(Colon)
    const value = this.SUBRULE(this.Value)
    return { name, value }
  })

  Directives = this.RULE('Directives', (): Directive[] => {
    const dirs: Directive[] = []
    this.AT_LEAST_ONE(() => {
      const d = this.SUBRULE(this.Directive)
      this.ACTION(() => dirs.push(d))
    })
    return dirs
  })

  Directive = this.RULE('Directive', (): Directive => {
    this.CONSUME(At)
    const name = this.CONSUME(Name).image
    const args = this.OPTION(() => this.SUBRULE(this.Arguments))
    return { name, arguments: args ?? [] }
  })

  VariableDefinitions = this.RULE('VariableDefinitions', (): unknown[] => {
    const defs: unknown[] = []
    this.CONSUME(LParen)
    this.AT_LEAST_ONE(() => {
      const d = this.SUBRULE(this.VariableDefinition)
      this.ACTION(() => defs.push(d))
    })
    this.CONSUME(RParen)
    return defs
  })

  VariableDefinition = this.RULE('VariableDefinition', (): unknown => {
    this.CONSUME(Dollar)
    const variable = this.CONSUME(Name).image
    this.CONSUME(Colon)
    const type = this.SUBRULE(this.Type)
    const defaultValue = this.OPTION(() => { this.CONSUME(Equals); return this.SUBRULE(this.Value) })
    return { variable, type, defaultValue: defaultValue ?? null }
  })

  private cType?: IOrAlt<GQLType>[]
  Type = this.RULE('Type', (): GQLType => {
    const inner: GQLType = this.OR(this.cType ??= [
      { ALT: () => ({ kind: 'NamedType' as const, name: this.CONSUME(Name).image }) },
      { ALT: () => {
        this.CONSUME(LSquare)
        const t = this.SUBRULE(this.Type)
        this.CONSUME(RSquare)
        return { kind: 'ListType' as const, type: t }
      }},
    ])
    const bang = this.OPTION(() => this.CONSUME(Exclamation))
    return bang ? { kind: 'NonNull', type: inner } : inner
  })

  private cValue?: IOrAlt<Value>[]
  Value = this.RULE('Value', (): Value =>
    this.OR(this.cValue ??= [
      { ALT: () => { this.CONSUME(Dollar); return { kind: 'Variable', name: this.CONSUME(Name).image } } },
      { ALT: () => parseFloat(this.CONSUME(FloatValue).image) },
      { ALT: () => parseInt(this.CONSUME(IntValue).image, 10) },
      { ALT: () => unescapeString(this.CONSUME(StringValue).image) },
      { ALT: () => { this.CONSUME(True); return true } },
      { ALT: () => { this.CONSUME(False); return false } },
      { ALT: () => { this.CONSUME(Null); return null } },
      { ALT: () => this.SUBRULE(this.ListValue) },
      { ALT: () => this.SUBRULE(this.ObjectValue) },
      { ALT: () => ({ kind: 'EnumValue', value: this.CONSUME2(Name).image }) },
    ]))

  ListValue = this.RULE('ListValue', (): Value[] => {
    const items: Value[] = []
    this.CONSUME(LSquare)
    this.MANY(() => {
      const v = this.SUBRULE(this.Value)
      this.ACTION(() => items.push(v))
    })
    this.CONSUME(RSquare)
    return items
  })

  ObjectValue = this.RULE('ObjectValue', (): Record<string, Value> => {
    const fields: [string, Value][] = []
    this.CONSUME(LCurly)
    this.MANY(() => {
      const f = this.SUBRULE(this.ObjectField)
      this.ACTION(() => fields.push(f))
    })
    this.CONSUME(RCurly)
    return Object.fromEntries(fields)
  })

  ObjectField = this.RULE('ObjectField', (): [string, Value] => {
    const name = this.CONSUME(Name).image
    this.CONSUME(Colon)
    const value = this.SUBRULE(this.Value)
    return [name, value]
  })
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export function buildChevrotainGraphQL(): (input: string) => unknown {
  const parser = new GQLParser()
  return (input: string) => {
    const { tokens, errors } = GraphQLLexer.tokenize(input)
    if (errors.length) throw new Error(errors[0]!.message)
    parser.input = tokens
    const result = parser.Document()
    if (parser.errors.length) throw new Error(parser.errors[0]!.message)
    return result
  }
}
