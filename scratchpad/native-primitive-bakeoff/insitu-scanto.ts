/**
 * IN-SITU A/B for PARSEMAN_SCANTO=indexof, on the repo's own workload grammars.
 *
 * Methodology, per docs/design/derived-tokenization.md §16.3 / §16.4:
 *   - Both sides compiled in ONE process by toggling the env the codegen reads,
 *     so the only difference is the emitted scan form.
 *   - CORRECTNESS FIRST: trees compared with bench/tree-identity.ts's own
 *     `serializeTree` / `firstDivergence` oracle. A green timing run on a
 *     diverging tree is worthless; the gate is tree equality, not a test suite.
 *   - Timing is interleaved round-robin in one process, order rotated per round,
 *     reporting median, min AND win rate. The instrument's noise floor is ~1%
 *     (§16.5: two BYTE-IDENTICAL artifacts A/B'd at 5.144 vs 5.200 ms, 6/15).
 *
 * Path is reported per row. G10: the AST path is the canonical measure.
 */
import { compile, type Combinator } from '../../src/index.ts'
import { serializeTree, firstDivergence } from '../../bench/tree-identity.ts'
import { buildWorkloads } from '../../bench/workloads/index.ts'

type Side = { parse: () => unknown }

function compileWith(flag: string, c: Combinator<unknown>, capture: boolean, input: string): Side {
  const prev = process.env.PARSEMAN_SCANTO
  process.env.PARSEMAN_SCANTO = flag
  const compiled = compile(c)
  if (prev === undefined) delete process.env.PARSEMAN_SCANTO
  else process.env.PARSEMAN_SCANTO = prev
  // Construct the context EXACTLY as bench/workloads/index.ts does. An earlier
  // version spread an extra `_triviaLog: undefined` onto the no-capture side,
  // which gives that object a different hidden class than the one the repo's
  // own workloads measure — a confound introduced by the harness, not the change.
  return capture
    ? { parse: () => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0) }
    : { parse: () => compiled.parseWithContext(input, { trackLines: false }, 0) }
}

// Rebuild the workload set, but compile each side ourselves so we control the flag.
const workloads = buildWorkloads()
const CAPTURE = new Set(['less/stylesheet', 'less/mixins', 'css/stylesheet'])

// `buildWorkloads` hides the combinator behind `make`, so pull the combinators
// directly — same objects it uses.
const { Stylesheet: LessStylesheet } = await import('../../bench/workloads/less.ts')
const { Stylesheet: CssStylesheet } = await import('../../examples/css/parser.ts')
const { graphqlDoc } = await import('../../examples/graphql/parser.ts')
const { jsonDoc } = await import('../../examples/json/parser.ts')
const COMB: Record<string, Combinator<unknown>> = {
  'less/stylesheet': LessStylesheet as Combinator<unknown>,
  'less/mixins': LessStylesheet as Combinator<unknown>,
  'css/stylesheet': CssStylesheet as Combinator<unknown>,
  'graphql/document': graphqlDoc as Combinator<unknown>,
  'json/document': jsonDoc as Combinator<unknown>,
}

const ROUNDS = 51
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]! }

console.log(`node ${process.version}, rounds ${ROUNDS}, noise floor ~1% (§16.5)\n`)

for (const w of workloads) {
  const comb = COMB[w.id]!
  const capture = CAPTURE.has(w.id)
  const path = capture ? 'CST (capture on)' : 'AST (no capture)'
  const A = compileWith('loop', comb, capture, w.input)
  const B = compileWith('indexof', comb, capture, w.input)

  // ---- CORRECTNESS GATE ----
  const ta = A.parse(), tb = B.parse()
  const sa = serializeTree(ta), sb = serializeTree(tb)
  if (sa !== sb) {
    const d = firstDivergence(ta, tb)
    console.log(`${w.id}: TREE DIVERGENCE at ${d?.path}\n  a=${d?.a}\n  b=${d?.b}`)
    continue
  }

  // ---- TIMING ----
  // BATCHED: a single 0.7 ms parse is dominated by timer granularity, GC and
  // scheduling — measured that way, two BYTE-IDENTICAL artifacts (graphql,
  // json: 0 converted sites) read 7.8% apart. Timing BATCH parses per sample
  // raises the signal above that. The two byte-identical grammars stay in the
  // run as a live noise calibration: whatever they read IS this instrument's
  // floor, and no row smaller than that is a result.
  const BATCH = 10
  for (let k = 0; k < 5; k++) { A.parse(); B.parse() }
  const ta_: number[] = [], tb_: number[] = []
  for (let r = 0; r < ROUNDS; r++) {
    const first = r % 2 === 0
    const run = (s: Side): number => {
      const t0 = process.hrtime.bigint()
      for (let k = 0; k < BATCH; k++) s.parse()
      const t1 = process.hrtime.bigint()
      return Number(t1 - t0) / 1e6 / BATCH
    }
    if (first) { ta_.push(run(A)); tb_.push(run(B)) }
    else { tb_.push(run(B)); ta_.push(run(A)) }
  }
  const wins = tb_.filter((v, k) => v < ta_[k]!).length
  const ma = med(ta_), mb = med(tb_)
  console.log(
    `${w.id.padEnd(18)} ${path.padEnd(18)} ${(w.bytes / 1024).toFixed(0).padStart(4)}KB  ` +
    `loop ${ma.toFixed(3)}  indexof ${mb.toFixed(3)}  rel ${(mb / ma).toFixed(4)}  ` +
    `min ${Math.min(...ta_).toFixed(3)}/${Math.min(...tb_).toFixed(3)}  wins ${wins}/${ROUNDS}  TREES EQUAL`,
  )
}
