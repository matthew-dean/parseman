/**
 * Orchestrator for the inlining-cliff experiment.
 *
 *   node bench/experiments/cliff/run.mjs [--quick]
 *
 * Every configuration runs in a FRESH child process, SERIALLY, so no configuration
 * inherits another's feedback vectors and no two timed runs contend. Results are
 * APPENDED to notes/results/inlining-cliff.jsonl, one record per configuration,
 * each stamped with the parseman SHA and the node version.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const OUT = join(repoRoot, 'notes', 'results', 'inlining-cliff.jsonl')
mkdirSync(dirname(OUT), { recursive: true })

const SHA = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const NODE = process.version
const RUN_ID = new Date().toISOString()
const V8 = process.versions.v8

const KINDS = ['seq', 'choice', 'many']
// 5 is NOT in the brief's N list but IS the first value past V8's 4-map polymorphic
// limit, so the sweep would step straight over the transition it was built to find.
const NS = [1, 2, 3, 4, 5, 6, 8, 12, 20, 40]
const TARGET_OPS = 300_000

const itersFor = (n, callSites) => Math.max(200, Math.ceil(TARGET_OPS / (callSites ?? n)))

function cfgKey(c) {
  return [c.kind, `n${c.n}`, c.shapes, `cap${c.captures ?? 0}`,
    c.chain ? 'chain' : '-', c.wrapper ? 'wrap' : '-',
    c.callSites ? `call${c.callSites}` : '-', c.v8flags?.join(',') || '-'].join('/')
}

function runThroughput(cfg) {
  const args = [...(cfg.v8flags ?? []), join(here, 'throughput.mjs'), JSON.stringify(cfg)]
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  return JSON.parse(out.trim().split('\n').pop())
}

const SLOT_RE = /- slot #(\d+) (\w+)\s+([A-Z_]+)/g
const FV_RE = /- feedback vector: (0x[0-9a-f]+)/g
const CODE_RE = /- code: 0x[0-9a-f]+ <Code ([A-Z_]+)/g

function runIcProbe(cfg) {
  const tmp = join(tmpdir(), `pm-cliff-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const args = ['--allow-natives-syntax', ...(cfg.v8flags ?? []),
    join(here, 'ic-probe.mjs'), JSON.stringify(cfg), tmp]
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  const rec = JSON.parse(readFileSync(tmp, 'utf8').trim())
  unlinkSync(tmp)

  // First DebugPrint block = site 0's shared body; second = the last site's body.
  const blocks = stdout.split('DebugPrint: ').slice(1)
  const slots = []
  let m
  SLOT_RE.lastIndex = 0
  while ((m = SLOT_RE.exec(blocks[0] ?? '')) !== null) {
    slots.push({ slot: Number(m[1]), kind: m[2], state: m[3] })
  }
  const fvs = []
  FV_RE.lastIndex = 0
  while ((m = FV_RE.exec(stdout)) !== null) fvs.push(m[1])
  const codes = []
  CODE_RE.lastIndex = 0
  while ((m = CODE_RE.exec(blocks[0] ?? '')) !== null) codes.push(m[1])

  const icSlots = slots.filter(s => ['LoadProperty', 'LoadKeyed', 'Call', 'StoreKeyed'].includes(s.kind))
  const rank = { UNINITIALIZED: 0, MONOMORPHIC: 1, POLYMORPHIC: 2, MEGAMORPHIC: 3, GENERIC: 3 }
  const worst = icSlots.reduce((a, s) => (rank[s.state] ?? 0) > (rank[a] ?? 0) ? s.state : a, 'UNINITIALIZED')

  return {
    ...rec,
    tier: codes[0] ?? 'unknown',
    icWorst: worst,
    icCounts: icSlots.reduce((a, s) => { a[s.state] = (a[s.state] ?? 0) + 1; return a }, {}),
    icSlots,
    sharedFeedbackVector: fvs.length >= 2 ? (fvs[0] === fvs[1]) : null,
    feedbackVectorAddrs: fvs.slice(0, 2),
  }
}

function runTraceProbe(cfg) {
  const tmp = join(tmpdir(), `pm-cliff-t-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const args = ['--allow-natives-syntax', '--trace-turbo-inlining', '--trace-deopt',
    join(here, 'ic-probe.mjs'), JSON.stringify(cfg), tmp]
  // BOTH --trace-turbo-inlining and --trace-deopt write to STDOUT in this build (an
  // empty stderr from the first attempt is what proved it), so the trace lines and the
  // %DebugPrint blocks share one stream. They are told apart by prefix.
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  const stream = String(res.stdout ?? '') + String(res.stderr ?? '')
  try { unlinkSync(tmp) } catch { /* ignore */ }

  const lines = stream.split('\n').map(l => l.trim())
  const considering = lines.filter(l => l.startsWith('Considering '))
  const inlined = lines.filter(l => l.startsWith('Inlining '))
  const notInlined = lines.filter(l => l.startsWith('Not inlining') || l.startsWith('Not considering'))
  const deopts = lines.filter(l => l.startsWith('[bailout') || l.includes('deoptimizing'))
  const norm = l => l.replace(/0x[0-9a-f]+/g, '0x')
  return {
    consideredForInlining: considering.length,
    inlinedCount: inlined.length,
    notInlinedCount: notInlined.length,
    inlinedParseIntoParse: inlined.filter(l => /parse>\} into .*parse>\}/.test(l)).length,
    notInlinedReasons: [...new Set(notInlined.map(norm))].slice(0, 12),
    deoptCount: deopts.length,
    deoptReasons: [...new Set(deopts.map(l => (l.match(/reason: ([^\]]+)/) ?? [])[1]).filter(Boolean))].slice(0, 12),
    inlineSampleLines: [...new Set(inlined.map(norm))].slice(0, 10),
  }
}

const records = []
function emit(group, cfg, throughput, ic, trace) {
  const rec = {
    runId: RUN_ID, sha: SHA, node: NODE, v8: V8,
    group, key: cfgKey(cfg),
    kind: cfg.kind, n: cfg.n, shapes: cfg.shapes,
    captures: cfg.captures ?? 0, chain: !!cfg.chain, wrapper: !!cfg.wrapper,
    callSites: cfg.callSites ?? cfg.n, v8flags: cfg.v8flags ?? [],
    nsPerOp: throughput?.nsPerOp ?? null,
    nsMin: throughput?.nsMin ?? null,
    nsMax: throughput?.nsMax ?? null,
    spreadPct: throughput?.spreadPct ?? null,
    samples: throughput?.samples ?? null,
    wrapperBytes: throughput?.wrapperBytes ?? ic?.wrapperBytes ?? 0,
    shapeCheck: ic?.shapeCheck ?? null,
    tier: ic?.tier ?? null,
    icWorst: ic?.icWorst ?? null,
    icCounts: ic?.icCounts ?? null,
    icSlots: ic?.icSlots ?? null,
    sharedFeedbackVector: ic?.sharedFeedbackVector ?? null,
    optStatus: ic?.status ?? null,
    trace: trace ?? null,
  }
  records.push(rec)
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  const t = rec.nsPerOp === null ? '     -  ' : rec.nsPerOp.toFixed(2).padStart(8)
  process.stderr.write(`${t} ns/op  ${(rec.icWorst ?? '-').padEnd(13)} ${rec.tier ?? '-'}  ${rec.key}\n`)
  return rec
}

const quick = process.argv.includes('--quick')

// ── 0. A/A control: identical configuration measured three times, spread apart ──
const AA = { kind: 'seq', n: 1, shapes: 'identical', iters: itersFor(1) }
emit('aa-control', AA, runThroughput(AA), runIcProbe(AA))

// ── 1. Main sweep: piece kind × N × shape policy ────────────────────────────────
for (const kind of KINDS) {
  for (const shapes of ['identical', 'distinct']) {
    for (const n of (quick ? [1, 4, 5, 40] : NS)) {
      const cfg = { kind, n, shapes, iters: itersFor(n) }
      emit('sweep', cfg, runThroughput(cfg), runIcProbe(cfg))
    }
  }
}

emit('aa-control', AA, runThroughput(AA), runIcProbe(AA))

// ── 2. Memory control: N sites BUILT, only 1 EXERCISED ──────────────────────────
for (const kind of KINDS) {
  for (const shapes of ['identical', 'distinct']) {
    const cfg = { kind, n: 40, shapes, callSites: 1, iters: itersFor(40, 1) }
    emit('memory-control', cfg, runThroughput(cfg), runIcProbe(cfg))
  }
}

// ── 3. Captured-variable count ──────────────────────────────────────────────────
for (const shapes of ['identical', 'distinct']) {
  for (const n of [1, 8]) {
    for (const captures of [0, 1, 3, 8]) {
      const cfg = { kind: 'seq', n, shapes, captures, iters: itersFor(n) }
      emit('captures', cfg, runThroughput(cfg), runIcProbe(cfg))
    }
  }
}

// ── 4. Call chain: does the cliff compound through a shared callee? ─────────────
for (const shapes of ['identical', 'distinct']) {
  for (const n of [1, 4, 5, 8, 40]) {
    const cfg = { kind: 'seq', n, shapes, chain: true, iters: itersFor(n) }
    emit('chain', cfg, runThroughput(cfg), runIcProbe(cfg))
  }
}

// ── 5. Per-site monomorphic wrapper in front of the shared body ─────────────────
for (const kind of KINDS) {
  for (const shapes of ['identical', 'distinct']) {
    for (const n of [1, 4, 5, 8, 40]) {
      const cfg = { kind, n, shapes, wrapper: true, iters: itersFor(n) }
      emit('wrapper', cfg, runThroughput(cfg), runIcProbe(cfg))
    }
  }
}

// ── 6. Causal lever: turn polymorphic inlining OFF and see whether the 2..4 ─────
//      region collapses onto the megamorphic level. A cliff that MOVES when the
//      knob moves is a cliff that was caused by the knob.
for (const n of [1, 2, 4, 5, 8, 40]) {
  const cfg = { kind: 'seq', n, shapes: 'distinct', v8flags: ['--no-polymorphic-inlining'], iters: itersFor(n) }
  emit('no-poly-inlining', cfg, runThroughput(cfg), runIcProbe(cfg))
}

// ── 7. Trace probes at the transition points ────────────────────────────────────
for (const kind of KINDS) {
  for (const shapes of ['identical', 'distinct']) {
    for (const n of [1, 2, 4, 5, 8, 40]) {
      const cfg = { kind, n, shapes, iters: itersFor(n) }
      emit('trace', cfg, null, runIcProbe(cfg), runTraceProbe(cfg))
    }
  }
}

emit('aa-control', AA, runThroughput(AA), runIcProbe(AA))

process.stderr.write(`\nwrote ${records.length} records to ${OUT}\n`)
