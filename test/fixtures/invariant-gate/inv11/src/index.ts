/**
 * TWO PLANTED VIOLATIONS, one per half of INV-8.
 *
 * 8a — the reference engine re-aliased to the shipped name. This is the edit
 * that made the two engines indistinguishable for two releases. Nothing here is
 * wrong to a type checker (both names have the same signature), which is why the
 * rule has to decide on the SPECIFIER.
 *
 * 8b — one function published under a second name from an entry point. This is
 * the shape that actually MINTED the collision: `src/table/index.ts` read
 * `export { assembledRules as tableRules, assembledRules, … }`, and no rename
 * crossed engines there — a synonym was simply created.
 */
import { execRules as tableRules } from './exec.ts'
export { shipped as alsoShipped } from './assemble.ts'

export const entry = (): number => tableRules()
