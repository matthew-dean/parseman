/**
 * Deterministic half of the inlining-cliff experiment: what V8 ACTUALLY decided.
 *
 * MUST be run as:
 *   node --allow-natives-syntax bench/experiments/cliff/ic-probe.mjs '<json cfg>' <outfile>
 *
 * `--trace-ic` does not exist in a release Node build (verified on v24.11.1:
 * `node: bad option: --trace-ic`). `%DebugPrint` is the stronger substitute and IS
 * available: for a function with an allocated feedback vector it prints every slot
 * with its IC state verbatim, e.g. `- slot #1 LoadProperty MEGAMORPHIC`. That is the
 * transition we are after, read straight out of the feedback vector rather than
 * inferred from timings.
 *
 * DebugPrint writes to fd 1 from C++, so the parent captures this process's stdout
 * and attributes each block by the `- source code:` line inside it. The machine
 * record is written to `<outfile>` instead of stdout so the two never interleave.
 *
 * --trace-turbo-inlining / --trace-deopt output lands on stderr and is captured by
 * the parent.
 */
import { writeFileSync } from 'node:fs'
import { buildSites, wrapSites, wrapSitesIndirect, makeCtx, makeLeaf, makeSeq, makeChoice, makeMany } from './pieces.mjs'

const dbg = (x) => %DebugPrint(x)
const optStatus = (f) => %GetOptimizationStatus(f)
const sameMap = (a, b) => %HaveSameMap(a, b)

const STATUS_BITS = [
  [1 << 0, 'isFunction'],
  [1 << 1, 'neverOptimize'],
  [1 << 2, 'alwaysOptimize'],
  [1 << 3, 'maybeDeopted'],
  [1 << 4, 'optimized'],
  [1 << 5, 'maglevved'],
  [1 << 6, 'turbofanned'],
  [1 << 7, 'interpreted'],
  [1 << 8, 'markedForOptimization'],
  [1 << 9, 'markedForConcurrentOptimization'],
  [1 << 10, 'optimizingConcurrently'],
  [1 << 11, 'isExecuting'],
  [1 << 12, 'topmostFrameIsTurboFanned'],
  [1 << 13, 'liteMode'],
  [1 << 14, 'markedForDeoptimization'],
  [1 << 15, 'baseline'],
  [1 << 16, 'topmostFrameIsInterpreted'],
  [1 << 17, 'topmostFrameIsBaseline'],
  [1 << 18, 'isLazy'],
  [1 << 19, 'topmostFrameIsMaglev'],
]

const decodeStatus = (v) => STATUS_BITS.filter(([b]) => (v & b) !== 0).map(([, n]) => n)

const cfg = JSON.parse(process.argv[2])
const outFile = process.argv[3]
const { kind, n, shapes, captures = 0, chain = false, wrapper = false, callSites, leafPad = 0, iters = 80000 } = cfg

const built = buildSites(kind, n, shapes, captures, chain, leafPad)
const innerSites = built.sites
let sites = innerSites
let wrapperBytes = 0
if (wrapper) {
  const w = wrapper === 'indirect' ? wrapSitesIndirect(innerSites) : wrapSites(innerSites)
  sites = w.wrapped
  wrapperBytes = w.bytes
}
const ctx = makeCtx()
const active = callSites ?? n

// Shape sanity. A silently wrong shape setup would make the whole experiment measure
// nothing, so assert it with %HaveSameMap rather than trusting the construction.
const l0 = makeLeaf('a', shapes === 'distinct' ? 0 : null)
const l1 = makeLeaf('a', shapes === 'distinct' ? 1 : null)
const leavesShareMap = sameMap(l0, l1)
const shapeCheck = shapes === 'distinct'
  ? (leavesShareMap ? 'BROKEN:distinct-leaves-share-a-map' : 'ok:distinct-maps')
  : (leavesShareMap ? 'ok:one-shared-map' : 'BROKEN:identical-leaves-differ')

// Do the N sites really share one feedback vector? Two closures out of one factory
// call site put the FeedbackCell into `many_closures` state, which is the mechanism
// the repo's design premise names. `factory` is DebugPrinted below so the cell array
// state is in the captured stdout.
const factory = { seq: makeSeq, choice: makeChoice, many: makeMany }[kind]

let sink = 0
for (let it = 0; it < iters; it++) {
  for (let s = 0; s < active; s++) {
    const r = sites[s].parse(built.inputs[s], 0, ctx)
    if (r.ok) sink++
  }
}

const record = {
  ...cfg,
  probe: 'ic',
  node: process.version,
  shapeCheck,
  wrapperBytes,
  sink,
  status: {
    sharedBody: (() => { const s = optStatus(innerSites[0].parse); return { raw: s, bits: decodeStatus(s) } })(),
    leafBody: (() => {
      const leaf = kind === 'many' ? innerSites[0]._def.combinator : innerSites[0]._def.parsers[0]
      const s = optStatus(leaf.parse)
      return { raw: s, bits: decodeStatus(s) }
    })(),
    factory: (() => { const s = optStatus(factory); return { raw: s, bits: decodeStatus(s) } })(),
    ...(wrapper
      ? { wrapperBody: (() => { const s = optStatus(sites[0].parse); return { raw: s, bits: decodeStatus(s) } })() }
      : {}),
  },
}

writeFileSync(outFile, JSON.stringify(record) + '\n')

// stdout: DebugPrint blocks only. Attribution is positional — first block is site 0's
// shared body, second is the LAST site's body. If the two print the SAME `feedback
// vector: 0x...` address then all N closures really do share one vector, which is the
// `many_closures` mechanism the repo's design premise names, observed directly.
dbg(innerSites[0].parse)
dbg(innerSites[innerSites.length - 1].parse)
if (wrapper) dbg(sites[0].parse)
// LAST block: the cold leaf twin. Never called, so it is still interpreted and its
// DebugPrint carries the `- bytecode: <BytecodeArray[N]>` line the hot leaf has
// already lost to tier-up. Same source as the hot leaves ⇒ same bytecode size.
// ONE call first: lazy compilation means an uncalled function has no BytecodeArray at
// all to print. One call compiles it and is far short of tier-up.
built.coldLeafTwin.parse('a', 0, ctx)
dbg(built.coldLeafTwin.parse)
