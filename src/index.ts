export type { Combinator, ParseResult, ParseOk, ParseFail, ParseContext, ParseError, Span, ParserMeta, FirstSet, CharRange, ParserDef, ChoiceStrategy, AutoNotCheck, GatedArm } from './types.ts'

export { literal } from './combinators/literal.ts'
export type { LiteralOptions } from './combinators/literal.ts'

export { regex } from './combinators/regex.ts'
export { keywords, word, makeWord } from './combinators/keywords.ts'
export type { KeywordsOptions } from './combinators/keywords.ts'

export { sequence } from './combinators/sequence.ts'
export { choice } from './combinators/choice.ts'
export { many, oneOrMore, optional, sepBy } from './combinators/repeat.ts'
export { rules } from './combinators/parser.ts'
export { ref } from './combinators/ref.ts'
export { not } from './combinators/not.ts'
export { node } from './combinators/node.ts'
export type { BuildNode, NodeOptions } from './combinators/node.ts'
// lazy() is intentionally NOT exported.
export { transform, skip, trivia, label } from './combinators/map.ts'
export { parse, parser, noTrivia } from './combinators/grammar.ts'
export type { ParseOptions, ParserOptions, ParsemanParser } from './combinators/grammar.ts'

export { compile } from './compiler/codegen.ts'
export type { CompiledParser } from './compiler/codegen.ts'

export { buildLineIndex, offsetToLineCol, annotateSpan } from './compiler/line-index.ts'
export type { LineIndex } from './compiler/line-index.ts'

export { guard } from './combinators/guard.ts'
export { withCtx } from './combinators/withCtx.ts'
export { recover, isParseError } from './combinators/recover.ts'
export { expect, staticExpected } from './combinators/expect.ts'
export { completionsAt } from './combinators/completions.ts'
export { scanTo, balanced } from './combinators/scanTo.ts'
export type { ScanToOptions } from './combinators/scanTo.ts'
export { sepByRecover, manyRecover } from './combinators/recover-list.ts'

export type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTChild, CSTRawChild, NodeLike } from './cst/types.ts'

export { parseDoc } from './functional/doc.ts'
export type { ParseDoc, ParseDocOptions, Registry, RuleFn } from './functional/doc.ts'
export { buildTriviaIndex } from './cst/trivia-index.ts'
export type { TriviaIndex, TriviaToken, TriviaIndexOptions } from './cst/trivia-index.ts'
export { walk, createVisitor } from './cst/walk.ts'
export type { Walkable, WalkVisitor, VisitApi, VisitorHandlers } from './cst/walk.ts'
export { triviaEntries } from './cst/trivia-entries.ts'
export type { TriviaEntriesView } from './cst/trivia-entries.ts'

export {
  OffsetIndex,
  buildOffsetIndex,
  collectLeafSlots,
  gapText,
  lineBreaksIn,
  blankLinesIn,
  lineStartWithin,
  indentWidth,
  indentMixed,
  commentsIn,
  gapIsSignificant,
} from './cst/offset-model.ts'
export type { Slot, Gap } from './cst/offset-model.ts'
export {
  relativize,
  absolutize,
  absoluteSpanAt,
  shiftAbsolute,
  applyEdit,
} from './cst/relative-spans.ts'
export type { AbsNode, RelNode } from './cst/relative-spans.ts'
