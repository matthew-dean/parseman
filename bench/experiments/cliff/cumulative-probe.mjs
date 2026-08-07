/**
 * Does a CALLER run out of inlining budget, so that a small callee which a small caller
 * inlines is refused by a large one?
 *
 *   node --allow-natives-syntax --trace-turbo-inlining \
 *     bench/experiments/cliff/cumulative-probe.mjs <K>
 *
 * Trace-only. No timings.
 *
 * WHY THIS MATTERS beyond the sweep: I earlier specified a test for jess's 1.30-1.32x
 * author-reducer gap as "read each reducer's BytecodeArray length under both engines".
 * That spec was WRONG and this probe is the corrected one. The reducers are IDENTICAL
 * SOURCE under both engines, so their own bytecode length is identical by construction
 * and reading it cannot discriminate anything. What can differ is whether the reducer
 * gets INLINED, and that is decided by the CALLER's budget, not the callee's size:
 *   --max-inlined-bytecode-size            = 460   (per callee)
 *   --max-inlined-bytecode-size-cumulative = 920   (per CALLER, across all inlinees)
 *   --max-inlined-bytecode-size-small      = 27    (exempt from the cumulative budget)
 * The emitted engine's callers are fused `_pf` bodies of 17-31 KB; the interpreted
 * engine's callers are small combinator `parse` bodies. Same reducer, different caller,
 * therefore possibly different inlining outcome — and a caller-side budget produces
 * exactly the flat, body-independent ratio that 1.30-1.32x looks like.
 *
 * This probe reproduces that mechanism in isolation: K DISTINCT call sites (unrolled, so
 * each has its own feedback slot rather than one megamorphic site), each to its own
 * ~65-byte leaf, and we count how many TurboFan actually inlines.
 */
import { makeLeaf, makeCtx } from './pieces.mjs'

const optStatus = (f) => %GetOptimizationStatus(f)

const K = Number(process.argv[2] ?? '8')

const leaves = Array.from({ length: K }, (_, i) => makeLeaf('a', null))
const args = leaves.map((_, i) => `t${i}`)
const calls = leaves
  .map((_, i) => `  r = t${i}.parse(input, pos, ctx); if (!r.ok) return r; n += r.span.end`)
  .join('\n')
const src = `
return function bigCaller(input, pos, ctx) {
  let r, n = 0
${calls}
  return { ok: true, value: n, span: { start: pos, end: pos + 1 } }
}`
// eslint-disable-next-line no-new-func
const bigCaller = new Function(...args, src)(...leaves)

const ctx = makeCtx()
for (let i = 0; i < 200000; i++) bigCaller('a', 0, ctx)

const BITS = [[1 << 4, 'optimized'], [1 << 6, 'turbofanned'], [1 << 15, 'baseline']]
process.stdout.write(`\n<<<K=${K} callSites=${K} tier=`
  + (BITS.filter(([b]) => (optStatus(bigCaller) & b) !== 0).map(([, n]) => n).join('+') || 'none')
  + `>>>\n`)
