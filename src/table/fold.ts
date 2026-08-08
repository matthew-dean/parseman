import { tableRules } from './assemble.ts'
import { expandCompactFolded, unfoldVariant, type CompactFolded, type FoldedProgram, type TableRule } from './program.ts'

// Emitted folded modules expand their wire literal ONCE, so every named export
// shares the family's structural variant/resolution owner.
export { expandCompactFolded } from './program.ts'

/**
 * Select ONE variant of a folded table and build its rule map.
 *
 * This is the load-time half of G4. A folded artifact ships one table plus, per
 * variant, the words that differ from it; this materialises the named variant
 * and hands the driver an ordinary `TableProgram`. The driver is not told which
 * variant it got and has no way to ask — the fold is finished before the driver
 * sees anything, exactly as `trackLines` is resolved before it today.
 *
 * Its own module rather than a second export from the driver so that a bundle
 * shipping a single-variant table does not pull the fold in, and so the driver
 * keeps having no import of its own.
 *
 * IT DRIVES `tableRules`, the shipped engine. This module predates
 * `63666b6`, which made the assembler `tableRules` by editing `table/index.ts`
 * ALONE; `fold.ts` imports `exec.ts` directly and so kept the interpreter. Every
 * folded artifact ships `import { tableVariants }` (`emit.ts`), so that was a
 * product path on the reference engine. Bound by its own name now.
 */
export function tableVariants(
  source: FoldedProgram | CompactFolded,
  name: string,
): Record<string, TableRule> {
  const folded = 'base' in source ? source : expandCompactFolded(source)
  return tableRules(unfoldVariant(folded, name))
}

/** The variant names a folded table carries, for a caller that wants to check. */
export function variantNames(source: FoldedProgram | CompactFolded): string[] {
  return Object.keys('base' in source ? source.variants : source.v)
}
