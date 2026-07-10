export type { Combinator, ParseResult, ParseOk, ParseFail, ParseContext, ParseError, Span, ParserMeta, FirstSet, CharRange, ParserDef, ChoiceStrategy, AutoNotCheck, GatedArm, BuildHost, CstCollapsePredicate, FieldCapture, FieldMap } from './types.ts'

export { literal } from './combinators/literal.ts'
export type { LiteralOptions } from './combinators/literal.ts'

export { regex } from './combinators/regex.ts'
// Wire the hand-rolled first-set analyzer into `regex()`. Importing the library
// entry opts you into precise choice-dispatch fast paths; a deep-path
// `import { regex }` (no library entry) gets a permissive fallback, so the
// analyzer tree-shakes out entirely. The analyzer is a small dependency-free
// regex parser (`./regex/first-set.ts`) — no `regexp-tree`, no codegen — so
// interpreter-only bundles stay lean.
import { registerRegexAnalyzer } from './combinators/regex.ts'
import { firstSetFromRegex } from './regex/first-set.ts'
registerRegexAnalyzer(firstSetFromRegex)
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
export { transform, skip, trivia, label, field } from './combinators/map.ts'
export { parse, parser, noTrivia } from './combinators/grammar.ts'
export type { ParseOptions, ParserOptions, ParsemanParser } from './combinators/grammar.ts'
export { token } from './combinators/token.ts'

export { compile } from './compiler/codegen.ts'
export type { CompiledParser, LinkablePieces } from './compiler/codegen.ts'
// `pick()` is deliberately NOT re-exported: build-inlining a `pick()` of an imported
// grammar can't yet carry that grammar's ambient trivia across the module boundary, so
// the macro would diverge from the interpreter. It stays internal (./compiler/linker.ts)
// for later exploration of that lowering; `compose()` is the public composition primitive.
export { compose, cstBuildHost } from './compiler/linker.ts'
export type { CstBuildHostOptions, FusedRule } from './compiler/linker.ts'

export { buildLineIndex, offsetToLineCol, annotateSpan } from './compiler/line-index.ts'
export type { LineIndex } from './compiler/line-index.ts'

export { guard } from './combinators/guard.ts'
export { withCtx } from './combinators/withCtx.ts'
export { recover, isParseError } from './combinators/recover.ts'
export { expect } from './combinators/expect.ts'
export { completionsAt } from './combinators/completions.ts'
export { scanTo, balanced } from './combinators/scanTo.ts'
export type { ScanToOptions } from './combinators/scanTo.ts'
export { sepByRecover, manyRecover } from './combinators/recover-list.ts'

export type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTChild, CSTRawChild, NodeLike } from './cst/types.ts'

export { parseDoc } from './functional/doc.ts'
export type { ParseDoc, ParseDocOptions, Registry, RuleFn } from './functional/doc.ts'
export { run } from './functional/run.ts'
export type { RunResult, RunOptions, Runnable } from './functional/run.ts'
export { buildTriviaIndex } from './cst/trivia-index.ts'
export type { TriviaIndex, TriviaToken, TriviaIndexOptions } from './cst/trivia-index.ts'
export { walk, createVisitor } from './cst/walk.ts'
export type { Walkable, WalkVisitor, VisitApi, VisitorHandlers } from './cst/walk.ts'
export { triviaEntries } from './cst/trivia-entries.ts'
export type { TriviaEntriesView } from './cst/trivia-entries.ts'
export { triviaKindMask } from './cst/trivia-kinds.ts'

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
  relativizeCST,
  absolutizeCST,
  absoluteSpanCST,
} from './cst/relative-spans.ts'
export type { AbsNode, RelNode } from './cst/relative-spans.ts'
