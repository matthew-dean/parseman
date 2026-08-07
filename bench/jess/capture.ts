/**
 * THE PROGRAM THE MACRO PRINTED, captured where it is evaluated.
 *
 * `hooks.mjs`'s `pm-capture:` scheme repoints the emitted
 * `import { tableRules } from 'parseman/table'` at this module. Nothing else in
 * the artifact changes, and `captureTableRules` forwards to the same
 * `tableRules` `parseman/table` exports, so a captured module is the shipping
 * artifact plus a side-effecting record.
 *
 * Why not read the emitted TEXT instead: the printed literal names the grammar
 * module's own imports inside the reducer pool, so it does not evaluate outside
 * that module. Capturing at the call site is the only way to get the object
 * without re-implementing the module's scope.
 */
import { tableRules } from '../../src/table/assemble.ts'
import type { CompactProgram, TableProgram, TableRule } from '../../src/table/program.ts'

export type Capture = {
  readonly source: TableProgram | CompactProgram
  /** The map the call returned — how a caller identifies WHICH export this is. */
  readonly rules: Record<string, TableRule>
}

export const captured: Capture[] = []

export function captureTableRules(source: TableProgram | CompactProgram): Record<string, TableRule> {
  const rules = tableRules(source)
  captured.push({ source, rules })
  return rules
}
