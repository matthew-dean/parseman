/**
 * The ROOT-CAPTURE POLICY of one local trivia scope, in one place.
 *
 * Three engines install a `parser({ trivia })` scope — the interpreter
 * (`combinators/grammar.ts`), source lowering (`compiler/codegen.ts`) and the
 * table (`table/assemble.ts`, `table/exec.ts`) — and each of them has to answer
 * the same two questions about selected root trivia. The refusal below was a
 * string literal in two of them and ABSENT from the third, which is how a table
 * parse came to accept a grammar the other two reject.
 *
 * Import-free, like the rest of `cst/`, so the drivers can reach it without
 * pulling the combinator set in.
 */

/** The message `parser()` raises for an unclassified local scope. Exported so the
 *  three engines cannot drift a word apart. */
export const ROOT_TRIVIA_SCOPE_REFUSAL
  = 'parser(): selected root trivia requires classifiedTrivia() for every local trivia scope, or rootCapture: \'opaque\'.'

/**
 * Refuse a local trivia scope that cannot be reported faithfully.
 *
 * With selected root capture active, a scope whose trivia is not classified and
 * is not declared opaque would silently drop the markers inside it. Throwing is
 * the contract (`combinators/grammar.ts:98`); returning a parse that quietly
 * omits them is the failure this exists to prevent.
 */
export function refuseUnclassifiedRootScope(strict: boolean | undefined): void {
  if (strict === true) throw new TypeError(ROOT_TRIVIA_SCOPE_REFUSAL)
}
