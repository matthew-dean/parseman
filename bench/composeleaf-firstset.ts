/**
 * CROSS-ARTIFACT composed first-char dispatch benchmark.
 *
 * This is the shape jess's CSS/Less/SCSS parsers ship and the one the 0.32.0
 * cross-artifact-first-set fix targets — the one NO other in-repo bench covered.
 * `bench/compose-dispatch.ts` is a SINGLE-artifact value choice whose refs resolve
 * within one artifact; here the refs cross an ARTIFACT BOUNDARY, resolved only at
 * FUSE time — the path that regressed to `any` before the fix:
 *
 *   - a RECOGNITION artifact of `@`-keyword regexes whose sources carry an internal
 *     `?`/`*` inside a `(?!…)` boundary lookahead — the exact pattern
 *     `canMatchEmptyAtStart` used to mis-flag as nullable, poisoning the rule's
 *     first-set to `any`; and
 *   - a CONSUMER artifact whose at-rule arms are `sequence(g.SyntaxAtRuleName,
 *     <broad/any-first-set prelude>, …)` — a CROSS-ARTIFACT ref followed by a
 *     scan-to-terminator prelude, where the ordered-chain recipe must STOP at the
 *     ref (not over-union the tail) to keep first-char dispatch.
 *
 * The two artifacts are compiled SEPARATELY (`compileLinkable`) and fused
 * (`fuseRules`) — the same `fusedBody` the macro's `composeLeaf` emits — so cross-
 * artifact refs are resolved only at fuse time.
 *
 * `dispatchEmitted` is a DETERMINISTIC gating signal (independent of timing noise):
 * true iff the fused document loop first-char-gates its at-rule arms on `@`(64). A
 * regression that loses cross-artifact dispatch flips it to false and fails the run.
 *
 * A/B across the change (the untracked file persists over checkout):
 *   git checkout <before> && node --import tsx/esm bench/composeleaf-firstset.ts
 *   git checkout <after>  && node --import tsx/esm bench/composeleaf-firstset.ts
 */
import { rules, sequence, choice, many, optional, literal, regex } from '../src/index.ts'
import { compileLinkable } from '../src/compiler/codegen.ts'
import { fuseRules, fusedBody } from '../src/compiler/linker.ts'

// Recognition artifact: `@`-keyword tokens (internal `?`/`*` inside boundary
// lookaheads) + a selector lead. NO semantic reductions.
const recog = rules(() => ({
  SyntaxMediaAt: regex(/@media(?![-\w])/i),
  SyntaxSupportsAt: regex(/@supports(?![-\w])/i),
  SyntaxKeyframesAt: regex(/@(?:-[a-z]+-)?keyframes(?![-\w])/i),
  SyntaxGenericAt: regex(/@(?!(?:media|supports|keyframes)(?![-\w]))-?[a-z][-a-z0-9]*(?![-\w])/i),
  SyntaxSelector: regex(/[.#]?[a-z][-a-z0-9]*/),
}))

// Consumer artifact: at-rule arms lead with a CROSS-ARTIFACT `g.Syntax…` ref, then a
// broad-first-set scan-to-terminator prelude. The document is `many(choice(…@-arms…,
// ruleset))` — a `.`/letter item must skip EVERY @-arm at the leading char.
const semantic = rules((g: Record<string, import('../src/index.ts').Combinator<unknown>>) => ({
  AtStmt: sequence(g.SyntaxGenericAt!, regex(/[^;]*/), literal(';')),
  MediaBlock: sequence(g.SyntaxMediaAt!, regex(/[^{]*/), literal('{'), regex(/[^{}]*/), literal('}')),
  SupportsBlock: sequence(g.SyntaxSupportsAt!, regex(/[^{]*/), literal('{'), regex(/[^{}]*/), literal('}')),
  KeyframesBlock: sequence(g.SyntaxKeyframesAt!, regex(/[^{]*/), literal('{'), regex(/[^{}]*/), literal('}')),
  Ruleset: sequence(g.SyntaxSelector!, optional(regex(/[ \t]+/)), literal('{'), regex(/[^{}]*/), literal('}')),
  Doc: many(sequence(optional(regex(/[ \t\n]+/)), choice(g.AtStmt!, g.MediaBlock!, g.SupportsBlock!, g.KeyframesBlock!, g.Ruleset!))),
}))

const pRecog = compileLinkable(Object.entries(recog), '_recog_')!
const pSem = compileLinkable(Object.entries(semantic), '_sem_')!

/**
 * True iff the fused choice first-char-gates an at-rule arm on `@`(64). Keyed on the
 * choice's `_chcode<N>` dispatch var (from `codePointAt`) — NOT a regex-internal
 * `charCodeAt(...) === 64` inside a recognizer — so it flips to false exactly when
 * cross-artifact dispatch is lost.
 */
export const dispatchEmitted = /_chcode\w*\s*===\s*64\b/.test(fusedBody([pRecog, pSem]).body)

const R = fuseRules([pRecog, pSem]) as Record<string, (input: string, pos: number, ctx: Record<string, unknown>) => { ok: boolean; span: { end: number } }>

// Ruleset-heavy input (the hot path — every non-`@` item must skip all @-arms).
const BLOCKS = [
  '.card { color: red; padding: 4px }',
  '#main { margin: 0 }',
  'a { text-decoration: none }',
  '.btn-primary { background: blue }',
  '@media screen { }',
  '.nav-item { display: flex }',
  '@supports (x:y) { }',
  'h1 { font-size: 2em }',
  '@import "x";',
  '.grid { gap: 8px }',
]
export const input = Array.from({ length: 2400 }, (_, i) => BLOCKS[i % BLOCKS.length]).join('\n')
export const parse = (): boolean => R.Doc!(input, 0, {}).ok

const check = R.Doc!(input, 0, {})
if (!check.ok || check.span.end !== input.length) {
  throw new Error(`composeleaf-firstset: PARSE INCOMPLETE — ok=${check.ok} end=${check.span.end}/${input.length}`)
}

// When run directly, report the deterministic gating signal + a median.
if (import.meta.url === `file://${process.argv[1]}`) {
  for (let i = 0; i < 200; i++) parse()
  const trials: number[] = []
  for (let t = 0; t < 20; t++) {
    const N = 400
    const start = performance.now()
    for (let i = 0; i < N; i++) parse()
    trials.push(((performance.now() - start) / N) * 1000)
  }
  trials.sort((a, b) => a - b)
  console.log(`composeleaf-firstset (cross-artifact fuse) — at-rule cluster (${input.length} bytes)`)
  console.log(`  cross-artifact first-char dispatch emitted: ${dispatchEmitted}`)
  console.log(`  min ${trials[0]!.toFixed(1)} µs/op   median ${trials[Math.floor(trials.length / 2)]!.toFixed(1)} µs/op`)
  if (!dispatchEmitted) { console.error('REGRESSION: cross-artifact at-rule arms lost first-char dispatch'); process.exit(1) }
}
