export type { Combinator, ParseResult, ParseOk, ParseFail, ParseContext, ParseError, Span, ParserMeta, FirstSet, CharRange, ParserDef, ChoiceStrategy, AutoNotCheck, GatedArm, DispatchCase, DispatchMatcherCase, BuildHost, CstCollapsePredicate, FieldCapture, FieldMap } from './types.ts'

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
export type { KeywordsOptions, WordOptions } from './combinators/keywords.ts'

export { sequence } from './combinators/sequence.ts'
export { choice } from './combinators/choice.ts'
export { dispatch, endsWith, makeWhen, matches, otherwise, routed, startsWith, when } from './combinators/dispatch.ts'
export type { DispatchArm, DispatchOtherwise, DispatchStringMatcher, DispatchWhen, DispatchWhenFactory, DispatchWhenOptions, DispatchWhenMatcher } from './combinators/dispatch.ts'
export { attempt } from './combinators/attempt.ts'
export { many, oneOrMore, optional, sepBy, oneOrMoreSep } from './combinators/repeat.ts'
export type { RepeatOptions, SepByOptions, TrailingSeparator } from './combinators/repeat.ts'
export { rules } from './combinators/parser.ts'
export { ref } from './combinators/ref.ts'
export { not } from './combinators/not.ts'
export { peek } from './combinators/peek.ts'
export { node } from './combinators/node.ts'
export type { BuildNode, NodeCombinator, NodeOptions, NodeProjectOptions } from './combinators/node.ts'
// lazy() is intentionally NOT exported.
export { transform, skip, trivia, classifiedTrivia, label, field } from './combinators/map.ts'
export { parse, parser, noTrivia } from './combinators/grammar.ts'
export type { ParseOptions, ParserOptions, ParsemanParser } from './combinators/grammar.ts'
export { token, leaf } from './combinators/token.ts'

export { compile } from './compiler/codegen.ts'
export type { CompiledParser, LinkablePieces, GatingOption, DuplicationOption, HostMode } from './compiler/codegen.ts'

export { analyzeGating, analyzeGatingRules, formatGatingWarnings, firstSetToString } from './analysis/gating.ts'
export type {
  GatingReport, ChoiceGating, AnyArm, Overlap, AntiPattern, Unanalysable,
  FirstSetCause, GatingWarnLevel, ChoiceStrategyTag, AnalyzeGatingOptions,
} from './analysis/gating.ts'
// Analyze a WHOLE grammar, including a `compose()` result — whose fused map holds
// rule FUNCTIONS, not combinators, and so cannot be walked by `analyzeGatingRules`
// directly. This is the entry point a composed grammar's author wants.
export { analyzeGrammarGating } from './analysis/grammar.ts'
export type { AnalysableGrammar } from './analysis/grammar.ts'

export {
  analyzeDuplication, analyzeDuplicationRules, formatDuplicationFindings,
  duplicationFindingCount, siteToString, alternationGroups, keywordRegexShape,
  extractCharClasses, charClassMembers, keywordAlternationHazards,
} from './analysis/duplication.ts'
export type {
  DuplicationReport, AnalyzeDuplicationOptions, DuplicationWarnLevel, Site,
  DuplicateFinding, NearDuplicateFinding, RegexFragmentFinding,
  RegexClassFinding, RegexClassVariant,
  ArmOverlapFinding, RewriteFinding, RewriteKind, SepByVerdict, KeywordRegexFinding, DivergentNodeFinding,
  StructureLossFinding,
} from './analysis/duplication.ts'
// `pick()` is deliberately NOT re-exported: build-inlining a `pick()` of an imported
// grammar can't yet carry that grammar's ambient trivia across the module boundary, so
// the macro would diverge from the interpreter. It stays internal (./compiler/linker.ts)
// for later exploration of that lowering. `composeLeaf()` is terminal by design;
// ordinary reusable grammar composition remains `compose()`.
export { compose, composeLeaf, cstBuildHost } from './compiler/linker.ts'
export type { CstBuildHostOptions, FusedRule } from './compiler/linker.ts'

export { buildLineIndex, createLineIndex, recordLineRange, normalizeLineIndex, offsetToLineCol, annotateSpan, annotateTreeSpans } from './line-index.ts'
export type { LineIndex } from './line-index.ts'

export { gate } from './combinators/gate.ts'
export { withCtx } from './combinators/withCtx.ts'
export { isParseError } from './combinators/expect.ts'
export { expect } from './combinators/expect.ts'
export { completionsAt } from './combinators/completions.ts'
export { scanTo, balanced } from './combinators/scanTo.ts'
export type { ScanToOptions } from './combinators/scanTo.ts'

export type { CSTNode, CSTLeaf, CSTError, CSTTrivia, CSTChild, CSTRawChild, NodeLike } from './cst/types.ts'

export { parseDoc } from './functional/doc.ts'
export type { ParseDoc, ParseDocOptions, Registry, RuleFn } from './functional/doc.ts'
export { run } from './functional/run.ts'
export type { RootTriviaCapture, RunResult, RunOptions, RunProfile, RunProfilePass, Runnable } from './functional/run.ts'
export { GRAMMAR_COVERAGE_DEFINITIONS, compiledGrammarCoverageDefinitions, createGrammarCoverageCollector, createGrammarInstrumentationContext, createGrammarTraceSink, grammarCoverageDefinitions, composedGrammarCoverageDefinitions, runWithGrammarCoverage } from './coverage.ts'
export type { GrammarCoverageCollector, GrammarCoverageDefinition, GrammarCoverageSnapshot, GrammarInstrumentationContext, GrammarTraceEvent, GrammarTracePhase, GrammarTraceSink, GrammarTraceSnapshot } from './coverage.ts'
export { buildTriviaIndex } from './cst/trivia-index.ts'
export type { TriviaIndex, TriviaToken, TriviaIndexOptions } from './cst/trivia-index.ts'
export { createVisitor } from './cst/walk.ts'
export type { Walkable, VisitorHandler, VisitorSpec } from './cst/walk.ts'
export type { GrammarReflection, GrammarNodeReflection, GrammarWithReflection } from './cst/reflection.ts'
export { buildRootTriviaIndex, triviaEntries } from './cst/trivia-entries.ts'
export type { RootTriviaGap, RootTriviaIndex, TriviaEntriesView } from './cst/trivia-entries.ts'
export { triviaKindMask } from './cst/trivia-kinds.ts'

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
