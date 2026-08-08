/**
 * Report the ACTUAL BytecodeArray length of each sized leaf, so the size sweep's x-axis
 * is measured bytecode rather than a padding count.
 *
 *   node --allow-natives-syntax bench/experiments/cliff/size-probe.mjs
 *
 * The leaves here are never called, so they are still interpreted and DebugPrint still
 * carries the `- bytecode:` line. A leaf that has tiered up prints `- code: <Code
 * TURBOFAN_JS>` and no bytecode line at all, which is why the sweep keeps a cold twin.
 */
import { makeSizedLeaf, makeLeaf } from './pieces.mjs'

const dbg = (x) => %DebugPrint(x)

const PADS = [0, 2, 8, 12, 14, 16, 18, 20, 24, 45, 70, 100, 150, 240, 500, 1200]
process.stdout.write('<<<PADS>>>' + JSON.stringify(PADS) + '\n')
// ONE call each: enough to force lazy compilation (so a BytecodeArray exists to
// measure) and far short of the tier-up thresholds (so it is not replaced by optimized
// code, which prints no bytecode line).
const ctx = {}
const base = makeLeaf('a', null).parse
base('a', 0, ctx)
dbg(base)
for (const pad of PADS) {
  const f = makeSizedLeaf('a', null, pad).leaf.parse
  f('a', 0, ctx)
  dbg(f)
}
