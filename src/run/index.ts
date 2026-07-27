/**
 * `parseman/run` — the minimal entry for EXECUTING an already-compiled grammar.
 *
 * The macro removes the combinators, the compiler and the codegen from your
 * bundle, but not the driver: running a compiled grammar is still a `run()` call,
 * so a package that SHIPS a parser keeps a runtime import of parseman. Importing
 * that driver from the main entry drags the whole library along — the combinator
 * set, `compile()`, the first-set analysis, the CST builders — none of which a
 * compiled parser touches.
 *
 * This entry exists so it doesn't have to. `run()`'s complete module closure is
 * three files (this, `recovery/scan.ts`, `cst/capture-buffer.ts`) — a fraction of
 * the main entry. `test/unit/run-entry-closure.test.ts` asserts that stays true,
 * so a future import into `functional/run.ts` that widens the closure fails the
 * suite rather than quietly re-inflating everyone's bundle.
 *
 * Use the main entry when you BUILD grammars; use this one when you only run
 * output the macro (or `compile()`) already produced.
 *
 *   import { run } from 'parseman/run'
 *   import { myGrammar } from './grammar.js'   // macro-compiled
 *
 *   const result = run(myGrammar, source, { trivia })
 */
export { buildRootTriviaIndex } from '../cst/trivia-entries.ts'
export { run } from '../functional/run.ts'
export type { Runnable, RunOptions, RunResult } from '../functional/run.ts'
export type { RootTriviaGap, RootTriviaIndex, TriviaEntriesView } from '../cst/trivia-entries.ts'
export type { ParseContext, ParseError, ParseResult } from '../types.ts'
