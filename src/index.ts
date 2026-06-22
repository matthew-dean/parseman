export type { Combinator, ParseResult, ParseOk, ParseFail, ParseContext, ParseError, Span, ParserMeta, FirstSet, CharRange, ParserDef, ChoiceStrategy, AutoNotCheck, GatedArm } from './types.ts'

export { literal } from './combinators/literal.ts'
export type { LiteralOptions } from './combinators/literal.ts'

export { regex } from './combinators/regex.ts'

export { sequence } from './combinators/sequence.ts'
export { choice } from './combinators/choice.ts'
export { many, oneOrMore, optional, sepBy } from './combinators/repeat.ts'
export { parser } from './combinators/parser.ts'
export { ref } from './combinators/ref.ts'
export { not } from './combinators/not.ts'
// lazy() is intentionally NOT exported.
export { transform, skip, trivia } from './combinators/map.ts'
export { parse } from './combinators/grammar.ts'

export { compile } from './compiler/codegen.ts'
export type { CompiledParser } from './compiler/codegen.ts'

export { buildLineIndex, offsetToLineCol, annotateSpan } from './compiler/line-index.ts'
export type { LineIndex } from './compiler/line-index.ts'

export { guard } from './combinators/guard.ts'
export { withCtx } from './combinators/withCtx.ts'
export { recover, isParseError } from './combinators/recover.ts'
export { scanTo, balanced } from './combinators/scanTo.ts'
export type { ScanToOptions } from './combinators/scanTo.ts'

export { Parser } from './cst/grammar.ts'
export type { Refs, RuleKeys } from './cst/grammar.ts'
export type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTChild, CSTRawChild, NodeLike } from './cst/types.ts'
export { IncrementalParser } from './cst/incremental.ts'
