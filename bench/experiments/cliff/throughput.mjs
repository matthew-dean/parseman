/**
 * Serial throughput driver for the inlining-cliff experiment.
 *
 * One `op` = one top-level `piece.parse(input, 0, ctx)` call. Work per op is constant
 * within a piece kind and independent of N: every site is structurally identical and
 * parses the same input. Only the identity (and, in the `distinct` arm, the hidden
 * class) of the leaves differs between sites.
 *
 * Timing discipline:
 *  - everything runs SERIALLY in one process, one configuration at a time;
 *  - each configuration gets a fresh child process (see run.mjs) so no configuration
 *    inherits another's feedback vectors;
 *  - REPS timed reps, median reported, plus min/max and the spread;
 *  - the caller pairs an A/A control (the same config measured twice) so the noise
 *    floor is measured, not assumed.
 */
import { buildSites, wrapSites, wrapSitesIndirect, makeCtx } from './pieces.mjs'

const WARMUP_ROUNDS = 10
const REPS = 11

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function measure(cfg) {
  const { kind, n, shapes, captures, chain, wrapper, callSites, leafPad, iters } = cfg
  const built = buildSites(kind, n, shapes, captures, chain, leafPad)
  let sites = built.sites
  let wrapperBytes = 0
  if (wrapper) {
    const w = wrapper === 'indirect' ? wrapSitesIndirect(sites) : wrapSites(sites)
    sites = w.wrapped
    wrapperBytes = w.bytes
  }
  const inputs = built.inputs
  const ctx = makeCtx()

  // `callSites` lets us build N sites but only EXERCISE the first k of them. With
  // k=1 and n=40 the feedback vectors stay monomorphic while the memory footprint is
  // that of 40 sites — which separates "IC pollution" from "more objects".
  const active = callSites ?? n

  let sink = 0
  const round = (its) => {
    for (let it = 0; it < its; it++) {
      for (let s = 0; s < active; s++) {
        const r = sites[s].parse(inputs[s], 0, ctx)
        if (r.ok) sink++
      }
    }
  }

  for (let w = 0; w < WARMUP_ROUNDS; w++) round(iters)

  const samples = []
  for (let r = 0; r < REPS; r++) {
    const t0 = process.hrtime.bigint()
    round(iters)
    const t1 = process.hrtime.bigint()
    const ops = iters * active
    samples.push(Number(t1 - t0) / ops)
  }

  const med = median(samples)
  return {
    nsPerOp: med,
    nsMin: Math.min(...samples),
    nsMax: Math.max(...samples),
    spreadPct: ((Math.max(...samples) - Math.min(...samples)) / med) * 100,
    samples: samples.map(x => Number(x.toFixed(4))),
    wrapperBytes,
    sink,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = JSON.parse(process.argv[2])
  const out = measure(cfg)
  process.stdout.write(JSON.stringify({ ...cfg, ...out, sink: undefined }) + '\n')
}
