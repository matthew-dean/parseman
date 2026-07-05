/**
 * Composed-grammar first-char dispatch benchmark (MACRO path).
 *
 * parseman's other benchmarks (JSON/CSV/GraphQL) are SINGLE grammars compiled
 * whole — they never exercise `compose()`. The first-char dispatch win lands on
 * COMPOSED grammars built by the MACRO: there, a `choice` arm that is a cross-rule
 * ref carried an `any` first-set, so every arm was tried per token (`_r_value`
 * walked all its arms). Fuse-time first-set resolution restores dispatch.
 *
 * Why the macro path specifically: RUNTIME `compose()` re-runs `rules()` (which
 * propagates first-sets), so it dispatches on both before/after and only shows the
 * correctness fix. The macro compiles each artifact separately — arms stay `any`
 * without fuse-time resolution — so it's where the SPEEDUP shows. This mirrors
 * how jess ships (macro-compiled css/less/scss).
 *
 * A/B it across the change (same untracked file persists over checkout):
 *   git checkout <before> && node --import tsx bench/compose-dispatch.ts
 *   git checkout <after>  && node --import tsx bench/compose-dispatch.ts
 */
import { transformMacro } from '../src/plugin/index.ts'

// CSS-value-shaped composed grammar: `value` is a choice over many cross-rule ref
// arms with mostly distinct first chars (the dispatch-friendly shape). `dimension`
// and `interp` are nullable-prefix sequences (optional() leader) — they exercise
// the sequence-first-set soundness fix too. Compiled through the macro's
// compose() → emitFusedSource path.
const SRC = `import { rules, choice, sequence, optional, many, literal, regex, compose } from 'parseman' with { type: 'macro' }
const base = rules(g => ({
  valueList: many(sequence(g.value, optional(regex(/[ \\t]+/)))),
  value: choice(g.dimension, g.hexcolor, g.func, g.ident, g.string, g.interp),
  dimension: sequence(optional(regex(/[-+]/)), regex(/[0-9]+(?:\\.[0-9]+)?/), optional(regex(/[a-z%]+/))),
  hexcolor: sequence(literal('#'), regex(/[0-9a-fA-F]{3,8}/)),
  func: sequence(regex(/[a-z][a-z0-9-]*/), literal('('), g.dimension, literal(')')),
  ident: regex(/[a-z][a-z0-9-]*/),
  string: sequence(literal('"'), regex(/[^"]*/), literal('"')),
  interp: sequence(optional(regex(/[.#]/)), regex(/@\\{[a-z]+\\}/)),
}))
const delta = rules(g => ({ ident: regex(/[a-zA-Z_][a-zA-Z0-9_-]*/) }))
export const grammar = compose([base, delta])`

const out = transformMacro(SRC, '/bench/compose-dispatch.macro.ts', new Set(['parseman']))
if (!out) throw new Error('macro did not transform')
if (out.warnings.length) console.warn('macro warnings:', out.warnings)
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, no-new-func
const grammar = new Function(
  out.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn grammar',
)() as Record<string, (input: string, pos: number, ctx: Record<string, unknown>) => { ok: boolean; span: { end: number } }>

// Report whether dispatch was actually emitted (a first-set guard on a value arm).
const hasDispatch = /_chcode\w*\s*(?:>=|===|<=)/.test(out.code)

const TOKENS = ['12px', '#ff0088', 'calc(3)', 'red', '"hello"', '@{var}', '.@{cls}', '-3.5em', '100%', 'blue']
const input = Array.from({ length: 4000 }, (_, i) => TOKENS[i % TOKENS.length]).join(' ')
const parse = (): boolean => grammar.valueList!(input, 0, {}).ok

const check = grammar.valueList!(input, 0, {})
if (!check.ok || check.span.end !== input.length) {
  console.error(`PARSE INCOMPLETE — ok=${check.ok} end=${check.span.end}/${input.length}`)
  process.exit(1)
}

for (let i = 0; i < 200; i++) parse()
const trials: number[] = []
for (let t = 0; t < 20; t++) {
  const N = 400
  const start = performance.now()
  for (let i = 0; i < N; i++) parse()
  trials.push(((performance.now() - start) / N) * 1000)
}
trials.sort((a, b) => a - b)
console.log(`compose-dispatch (macro) — value-list (${input.length} bytes, 6-arm ref choice)`)
console.log(`  first-char dispatch emitted: ${hasDispatch}`)
console.log(`  min ${trials[0]!.toFixed(1)} µs/op   median ${trials[Math.floor(trials.length / 2)]!.toFixed(1)} µs/op`)
