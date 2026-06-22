import type { Span } from '../types.ts'

/**
 * Minimal interface a node must satisfy for IncrementalParser to navigate and
 * re-parse the tree. Satisfying this is all that's required for a custom AST
 * produced by overriding GrammarParser.buildNode().
 *
 * `children` only needs to be iterable with items that have `_tag` so the
 * traversal code can distinguish sub-nodes from leaves. For incremental
 * replacement, nodes are reconstructed via object spread — so plain objects
 * work naturally; class instances with non-enumerable properties do not.
 */
export type NodeLike = {
  readonly _tag: 'node'
  readonly type: string
  readonly span: Span
  readonly savedContext: unknown
  readonly children: ReadonlyArray<{ readonly _tag: string }>
}

/**
 * A named CST node produced by a capital-letter rule method in GrammarParser.
 * Children are in parse order: CSTNode children from named sub-parser interspersed
 * with CSTLeaf terminals from literal() / regex() calls inside lowercase helpers.
 */
export type CSTNode = {
  readonly _tag: 'node'
  /** Rule name — the method name that produced this node. */
  readonly type: string
  readonly span: Span
  readonly children: CSTChild[]
  /**
   * Shallow clone of ctx.user at the moment this node's parse began.
   * Used as the re-entry point for incremental re-parsing.
   * Only meaningful when ctx.user is primitives-only (no mutable objects).
   */
  readonly savedContext: unknown
}

/**
 * A terminal token — the result of a literal() or regex() match inside a CST rule.
 * Lowercase helpers are transparent: their terminals surface as leaves of the
 * nearest enclosing capital-letter rule.
 */
export type CSTLeaf = {
  readonly _tag: 'leaf'
  readonly value: string
  readonly span: Span
}

/**
 * A record of a failed rule parse — produced when error recovery is active.
 * Carries what was successfully parsed before the failure (partial children)
 * and the expected tokens at the failure point.
 */
export type CSTError = {
  readonly _tag: 'error'
  readonly type: string
  readonly span: Span
  readonly expected: string[]
  readonly children: CSTChild[]   // partial parse: what succeeded before failure
  readonly savedContext: unknown
}

export type CSTChild = CSTNode | CSTLeaf | CSTError

/**
 * A trivia token — whitespace or comment consumed between terms during parsing.
 * Only present in `rawChildren`; never in the structural `children` array.
 */
export type CSTTrivia = {
  readonly _tag: 'trivia'
  readonly value: string
  readonly span: Span
}

/** Full child union including trivia — used in the `rawChildren` arg of `buildNode`. */
export type CSTRawChild = CSTNode | CSTLeaf | CSTTrivia | CSTError
