/**
 * REALIZED-MAP MEASUREMENT + IN-SITU A/B for `_ctx` shape.
 *
 * Prior art: a hidden-class unification in this project was built, measured and
 * REVERTED, with the recorded lesson "count REALIZED maps, not construction
 * sites" and a noise band of ±4.9%. This measures realized maps first.
 *
 * Structural facts from the real css artifact that make this testable with NO
 * codegen change at all:
 *   - the artifact never constructs a context: 0 `{..._ctx}` sites, 0 derived
 *     `_ctxN` variables. The one `..._ctx` is `[..._ctx._fx]` into a result.
 *   - so there is exactly ONE context object per parse, and it is the object
 *     the CALLER passed in.
 *   - the artifact ADDS 7 fields to it during the parse (_fx _fe _cstChildren
 *     _cstRawChildren _cstLeaves _cstTriviaLog captureTrivia), none of which
 *     exist on any construction site.
 *
 * Therefore "unify the map" == "hand in an object that already has the fields",
 * which is a caller-side change. Arm A is today's literal; arm B pre-declares.
 * Same artifact, same input, same work — only the incoming object's shape.
 *
 * Self-calibrating: an A-vs-A arm runs in the SAME loop to give the noise floor
 * in-run, because both arms here share one artifact and a floor quoted from
 * memory is not evidence.
 */
import { compile, type Combinator } from '../../src/index.ts'
import { serializeTree, firstDivergence } from '../../bench/tree-identity.ts'
import { buildWorkloads } from '../../bench/workloads/index.ts'

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
const CAPTURE = new Set(['less/stylesheet', 'less/mixins', 'css/stylesheet'])

// Arm A — exactly what bench/workloads/index.ts hands in today.
const mkPlain = (capture: boolean): Record<string, unknown> =>
  capture ? { trackLines: false, _triviaLog: [] } : { trackLines: false }

// Arm B — the same context with the 7 artifact-written fields PRE-DECLARED, so
// the object never transitions during the parse. Values match what the artifact
// would have installed on first write, so behaviour is unchanged.
const mkPre = (capture: boolean): Record<string, unknown> => {
  const o: Record<string, unknown> = capture
    ? { trackLines: false, _triviaLog: [] }
    : { trackLines: false }
  o._fx = undefined
  o._fe = undefined
  o._cstChildren = undefined
  o._cstRawChildren = undefined
  o._cstLeaves = undefined
  o._cstTriviaLog = undefined
  o.captureTrivia = undefined
  return o
}

const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]! }
const ROUNDS = 51
const BATCH = 10

console.log(`node ${process.version}, rounds ${ROUNDS}, batch ${BATCH}\n`)

for (const w of buildWorkloads()) {
  const capture = CAPTURE.has(w.id)
  const compiled = compile(COMB[w.id]!)
  const run = (mk: () => Record<string, unknown>) => () =>
    compiled.parseWithContext(w.input, mk() as never, 0)

  const A = run(() => mkPlain(capture))
  const B = run(() => mkPre(capture))
  const A2 = run(() => mkPlain(capture)) // control: same arm as A

  // ---- CORRECTNESS ----
  const sa = serializeTree(A()), sb = serializeTree(B())
  if (sa !== sb) {
    const d = firstDivergence(A(), B())
    console.log(`${w.id}: TREE DIVERGENCE at ${d?.path}\n  a=${d?.a}\n  b=${d?.b}`)
    continue
  }

  for (let k = 0; k < 5; k++) { A(); B(); A2() }
  const ta: number[] = [], tb: number[] = [], tc: number[] = []
  const timeIt = (f: () => unknown): number => {
    const t0 = process.hrtime.bigint()
    for (let k = 0; k < BATCH; k++) f()
    return Number(process.hrtime.bigint() - t0) / 1e6 / BATCH
  }
  for (let r = 0; r < ROUNDS; r++) {
    if (r % 2 === 0) { ta.push(timeIt(A)); tb.push(timeIt(B)); tc.push(timeIt(A2)) }
    else { tc.push(timeIt(A2)); tb.push(timeIt(B)); ta.push(timeIt(A)) }
  }
  const ma = med(ta), mb = med(tb), mc = med(tc)
  const winsB = tb.filter((v, k) => v < ta[k]!).length
  const winsC = tc.filter((v, k) => v < ta[k]!).length
  console.log(
    `${w.id.padEnd(18)} ${(capture ? 'CST' : 'AST').padEnd(4)} ` +
    `plain ${ma.toFixed(3)}  predecl ${mb.toFixed(3)}  rel ${(mb / ma).toFixed(4)} wins ${winsB}/${ROUNDS}  ` +
    `| CONTROL A-vs-A rel ${(mc / ma).toFixed(4)} wins ${winsC}/${ROUNDS}`,
  )
}
