/**
 * `parseman/diagnostics` — the library twin of the `parseman` bin.
 *
 * A SEPARATE ENTRY POINT, deliberately. The verified-fix loop recompiles the grammar to
 * check its own rewrite, so everything here reaches the compiler. Re-exporting it from
 * `parseman` would put codegen on the import graph of every consumer who only wanted to
 * parse something — and parseman has just spent a release discovering what unasked-for
 * bytes cost. A diagnostics surface is a development tool; it should be findable, and it
 * should cost nothing to the people not using it.
 *
 * Everything here is also reachable from the CLI, which is the surface most people
 * want:
 *
 *     parseman diagnose src/grammar.ts
 *     parseman fix src/grammar.ts --corpus test/fixtures
 */
export { proposeFixes, applyFixEdits } from './fix.ts'
export type {
  FixReport, VerifiedFix, LocatedFinding, FixEdit, FixBenefit, FixEvidence,
  FixSample, FixCode, FixEngine, ProposeFixOptions,
} from './fix.ts'

export { renderFixReport } from './fix-render.ts'
export type { FixRenderOptions } from './fix-render.ts'

export { renderDiagnosis, groupDigits } from './diagnose-render.ts'
export type { DiagnoseRenderOptions } from './diagnose-render.ts'

export { measureChoiceCost, armFirstSets } from './corpus.ts'
export type { CorpusSample, CorpusSite, ChoiceCorpusCost, ArmCorpusCost } from './corpus.ts'

export { rebuildCombinator } from './rebuild.ts'
export type { RebuildResult, FrozenSubtree } from './rebuild.ts'
