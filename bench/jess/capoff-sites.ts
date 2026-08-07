/**
 * THE CAP_ON CENSUS — how many emitted sites the label pass believes are
 * capturing trivia, for a `hostMode: 'ast'` parse that carries no CST at all.
 *
 * Deliberately over the SAME reachable set `emit-assembly.ts:405` lowers (rule
 * entries plus the scan pool's `extraIps`) and with the SAME `hostCst` the
 * emitter passes, because a census over a different set is not a census of the
 * thing that runs.
 *
 * Also attributes each CAP_ON `OP_NODE` to the encode-time term that set its
 * flag bit 4, so the answer is a CAUSE rather than a count.
 */

import { CAP_OFF, CAP_ON, CAP_UNKNOWN, computeSiteLabels, reachableSites } from '../../src/table/site-labels.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { OP_NODE, OP_NODE_TRACK } from '../../src/table/ops.ts'
import { loadGrammar, type Dialect, type Variant } from './grammars.ts'
import { VARIANT_SETTINGS } from './grammars.ts'

const dialect = (process.argv[2] ?? 'css') as Dialect
const variant = (process.argv[3] ?? 'ast') as Variant

const g = await loadGrammar(dialect, variant)
const prog = encodeTable(g.rules, VARIANT_SETTINGS[variant])
// `resolveTable` is what the engine runs against, and it holds the code as the
// `Int32Array` the label pass takes; `prog.code` is the plain array it is built
// from. Same words either way — this is a type, not a copy of a different table.
const code = Int32Array.from(prog.code)

// `assemble.ts:2506-2511`, verbatim, so the root set matches what is lowered.
const extraIps: number[] = []
for (const s of prog.scans ?? []) {
  for (const r of s.skip ?? []) extraIps.push(r[0])
  if (s.sentinel !== undefined) extraIps.push(s.sentinel[0])
}
for (const set of prog.scanSkip ?? []) for (const r of set) extraIps.push(r[0])

const hostCst = variant.startsWith('cst')
const roots = [...Object.values(prog.rules), ...extraIps]
const labels = computeSiteLabels(code, roots, hostCst)
const sites = reachableSites(code, roots)

let on = 0
let off = 0
let unk = 0
let buf = 0
let triKnown = 0
for (const ip of sites) {
  const l = labels.at(ip)
  const c = l.cap
  if (c === CAP_ON) on++
  else if (c === CAP_OFF) off++
  else if (c === CAP_UNKNOWN) unk++
  if (l.buf) buf++
  if (l.tri >= 0) triKnown++
}

let nodeSites = 0
let nodeFlagged = 0
for (const ip of sites) {
  const op = code[ip]
  if (op !== OP_NODE && op !== OP_NODE_TRACK) continue
  nodeSites++
  if ((code[ip + 3]! & 4) !== 0) nodeFlagged++
}

console.log(JSON.stringify({
  dialect,
  variant,
  hostCst,
  sites: sites.size,
  capOn: on,
  capOff: off,
  capUnknown: unk,
  capOnPct: +(100 * on / sites.size).toFixed(1),
  bufTrue: buf,
  bufTruePct: +(100 * buf / sites.size).toFixed(1),
  triKnown,
  triKnownPct: +(100 * triKnown / sites.size).toFixed(1),
  nodeSites,
  nodeFlaggedCapture: nodeFlagged,
  nodeFlaggedPct: +(100 * nodeFlagged / Math.max(1, nodeSites)).toFixed(1),
}, null, 2))
