/**
 * THE CEILING on fixing the megamorphic builder call site — measured, not modelled.
 *
 * Every builder in a table grammar reaches ONE `build(...)` call site,
 * `src/table/exec.ts`'s `OP_NODE` path. less has 259 distinct builders against
 * V8's inline-cache limit of 4, so that site is megamorphic by construction.
 * Codegen calls each builder from its own site and does not pay for this.
 *
 * The question this file answers is NOT "is the site megamorphic" — it is, by
 * inspection. It is "what is fixing it WORTH, in milliseconds on
 * benchmark.less". Building first and measuring after is how a lane spends a
 * week on 1%.
 *
 * HOW THE NUMBER IS OBTAINED. The REAL builder call sequence is recorded from a
 * REAL table parse of benchmark.less — real `fns`, real argument tuples, real
 * order, real allocation — by wrapping the encoded program's `fns` before
 * `tableRules()`. That recording is then REPLAYED through three dispatch shapes
 * whose bodies are otherwise identical:
 *
 *   MEGA  `fns[i](...)`      — one call site, every builder. Today's exec.ts.
 *   ARITY `switch (arity)`   — one site per declared builder arity. The
 *                              arity-bucketed trampoline hypothesis.
 *   HOT8  8 sites + fallback — the eight hottest builders each get their own
 *                              site, everything else keeps the shared one. The
 *                              realistic small-code proposal.
 *   MONO  `switch (i)`       — one site per builder, each seeing exactly one
 *                              function, reached through a jump table.
 *                              This is the CEILING: no dispatch shape can beat
 *                              a monomorphic site per builder.
 *
 * Builder indices are DENSIFIED first, so every `switch` here is over a
 * contiguous 0..n-1 range. A switch over the raw `fns` indices is sparse — 85
 * live values scattered through 265 — and V8 need not lay a sparse switch out as
 * a jump table. Measuring that would be measuring the probe, and would understate
 * the ceiling it exists to establish.
 *
 * Because the three legs run the same builders on the same arguments in the same
 * order, the delta between them is DISPATCH and nothing else. Replay is not the
 * parse, so the absolute replay milliseconds are not a parse time — the figure
 * that transfers is MEGA-minus-MONO, which is the dispatch cost the parse pays
 * on top of the builder work it would pay anyway.
 *
 * A/A CONTROL runs alongside: MEGA against a second, independently constructed
 * MEGA. Its delta is this run's noise floor and no other delta is readable
 * without it.
 *
 * ── THE ANSWER, 2026-08-04, less / benchmark.less / 106802 B ────────────────
 *
 * The site IS megamorphic, and it does NOT cost what the 6% attribution implied.
 *
 *   builder invocations in one parse   28392
 *   DISTINCT builders realised            85   (not the 259 the grammar defines)
 *   top-8 share of all invocations      69.6%
 *   MEGA - MONO, replay, 3 runs   -0.08 / +0.07 / +0.07 ms   noise +1.4/+2.3/+0.9%
 *   MEGA - ARITY, replay, 3 runs  -0.17 / -0.03 / -0.02 ms   — never a win
 *   MEGA - HOT8,  replay, 2 runs         +0.14 / +0.06 ms
 *
 * The whole of the builder work — every dispatch AND every builder body, all
 * 28392 of them — replays in 2.6 ms of a 48 ms parse. Dispatch inside that is at
 * the noise floor.
 *
 * CONFIRMED IN THE DRIVER, so the replay's tight loop could not be blamed for
 * keeping V8's megamorphic stub cache hotter than the real recognizer does. A
 * throwaway patch threaded a `monoDispatch` flag into `tableRules` ->
 * `makeDriver`, which chose at OP_NODE between the shipped inline
 * `fns[buildIdx](...)` and a generated `switch (buildIdx)` with one case per
 * builder — the mega leg left as the ORIGINAL inline code, since routing it
 * through a shared helper would have added a frame it does not pay and biased
 * the contest. Both legs digested identically to each other AND to the
 * interpreter. Same process, interleaved, three replicates:
 *
 *   mega 45.19  mono 45.02 ms   MONO BUYS 0.17 ms   control spread 0.20 ms
 *   mega 44.59  mono 44.50 ms   MONO BUYS 0.09 ms   control spread 0.05 ms
 *   mega 47.57  mono 47.48 ms   MONO BUYS 0.09 ms   control spread 0.23 ms
 *
 * ~0.1 ms against a 29-31 ms table-vs-codegen gap: 0.3%, inside the noise floor,
 * and bought with a 259-case generated switch per table — codegen, which is the
 * size the table design exists to avoid. The patch was REVERTED and nothing in
 * `src/` changed. Arity-bucketed trampolines are REJECTED on measurement, not on
 * taste: the ARITY leg never won a single run.
 *
 * WHY the intuition was wrong, since the site really does see 85 shapes: a
 * megamorphic site is not a slow site, it is a site that misses the inline cache
 * and consults the global stub cache. That is a hash lookup, tens of cycles,
 * against builders that allocate a node and are hundreds. And the call is skewed
 * — 8 builders take 69.6% of invocations, so the stub cache hits hot and stays
 * hot. Megamorphism costs when it lands on cheap callees, and node builders are
 * not cheap callees.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/builder-dispatch-ceiling.ts [dialect]`
 */
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { interleave, median, sign, type Case, type Contest, type Measurement } from '../ab-harness.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { ENTRY, JESS_ROOT, VARIANT_SETTINGS, assertParseman, loadGrammar, type Dialect } from './grammars.ts'
import type { Combinator } from '../../src/types.ts'

const FIXTURE: Record<Dialect, string> = {
  less: 'packages/jess/benchmark/benchmark.less',
  css: 'packages/jess/benchmark/benchmark.css',
  scss: 'packages/jess/benchmark/gen-workload.scss',
  jess: 'packages/jess/benchmark/benchmark.jess',
}

const M: Measurement = { targetSampleMs: 0, warmup: 3, timed: 5, rounds: 8, runs: 2 }

/** One recorded builder invocation: the `fns` index, and the six real arguments. */
type Call = [number, unknown, unknown, unknown, unknown, unknown, unknown]

type Builder = (
  children: readonly unknown[], fields: unknown, span: unknown,
  rawChildren: readonly unknown[], triviaLog: unknown, state: unknown,
) => unknown

/**
 * Record every SIX-ARGUMENT `fns` call of one real parse.
 *
 * Six arguments is what `exec.ts`'s `OP_NODE` path passes and what nothing else
 * passes — `OP_LEAF` calls its fn with two. Filtering on the call itself rather
 * than on an encode-time flag means this cannot drift from what the driver
 * actually does.
 */
function record(dialect: Dialect, input: string): { calls: Call[]; fns: readonly unknown[] } {
  const rules = loadedRules.get(dialect)!
  const prog = encodeTable(rules, VARIANT_SETTINGS.ast)
  const fns = prog.fns
  const calls: Call[] = []
  const wrapped = fns.map((f, i) =>
    typeof f !== 'function'
      ? f
      : function (this: unknown, ...args: unknown[]): unknown {
          if (args.length === 6) calls.push([i, args[0], args[1], args[2], args[3], args[4], args[5]])
          return (f as (...a: unknown[]) => unknown).apply(this, args)
        })
  const entry = tableRules({ ...prog, fns: wrapped })[ENTRY] as Parameters<typeof run>[0]
  run(entry, input)
  return { calls, fns }
}

/** MEGA: one call site for every builder. This is `exec.ts:824` as it stands. */
function makeMega(fns: readonly unknown[]): (calls: readonly Call[]) => void {
  return (calls) => {
    for (let n = 0; n < calls.length; n++) {
      const c = calls[n]!
      const b = fns[c[0]] as Builder
      b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6])
    }
  }
}

/**
 * ARITY: one call site per declared builder arity.
 *
 * The hypothesis under test. Note it is only a WIN if the arity buckets are
 * narrow; a bucket holding 200 of the 259 builders is still megamorphic, and
 * this leg is here to show that rather than to assume it either way.
 */
function makeArity(fns: readonly unknown[], arity: Int8Array): (calls: readonly Call[]) => void {
  return (calls) => {
    for (let n = 0; n < calls.length; n++) {
      const c = calls[n]!
      const i = c[0]
      const b = fns[i] as Builder
      switch (arity[i]) {
        case 0: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
        case 1: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
        case 2: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
        case 3: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
        case 4: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
        case 5: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
        default: b(c[1] as readonly unknown[], c[2], c[3], c[4] as readonly unknown[], c[5], c[6]); break
      }
    }
  }
}

/**
 * HOT8: the eight hottest builders get a site each; the rest keep the shared one.
 *
 * This is the shape worth proposing if the ceiling is worth anything, because it
 * is eight call sites of driver code rather than a table inlined into a switch.
 * Its ceiling is bounded by the hot share, printed above.
 */
function makeHot8(fns: readonly unknown[], hot: readonly number[]): (calls: readonly Call[]) => void {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hot.map(i => fns[i] as Builder)
  return (calls) => {
    for (let n = 0; n < calls.length; n++) {
      const c = calls[n]!
      const a1 = c[1] as readonly unknown[], a4 = c[4] as readonly unknown[]
      switch (c[0]) {
        case hot[0]: h0!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[1]: h1!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[2]: h2!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[3]: h3!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[4]: h4!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[5]: h5!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[6]: h6!(a1, c[2], c[3], a4, c[5], c[6]); break
        case hot[7]: h7!(a1, c[2], c[3], a4, c[5], c[6]); break
        default: (fns[c[0]] as Builder)(a1, c[2], c[3], a4, c[5], c[6])
      }
    }
  }
}

/**
 * MONO: one call site per builder, generated, reached by a dense `switch`.
 *
 * `new Function` is the only way to get N distinct call sites in JS; a closure
 * per builder does NOT produce them, because every closure over one body shares
 * that body's single site. A sibling lane measured that closure-tree shape and
 * found no dispatch win, which is the same fact from the other side.
 *
 * This leg is the CEILING and not a proposal: a 259-case switch over builder
 * index is a jump table, but it is also the whole table inlined into the driver,
 * which is the megabyte-codegen outcome the design exists to avoid.
 */
function makeMono(fns: readonly unknown[], used: readonly number[]): (calls: readonly Call[]) => void {
  const arg = 'c[1],c[2],c[3],c[4],c[5],c[6]'
  const cases = used.map(i => `case ${i}: f${i}(${arg}); break;`).join('\n')
  const params = used.map(i => `f${i}`)
  const body = `return function (calls) {
    for (let n = 0; n < calls.length; n++) {
      const c = calls[n];
      switch (c[0]) {
${cases}
      }
    }
  }`
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(...params, body) as (...f: unknown[]) => (calls: readonly Call[]) => void
  return make(...used.map(i => fns[i]))
}

const loadedRules = new Map<Dialect, Record<string, Combinator<unknown>>>()

async function main(): Promise<void> {
  const pm = await assertParseman()
  const dialect = (process.argv[2] ?? 'less') as Dialect
  console.log(`parseman ${pm.version}   ${pm.root}   node ${process.version}`)
  console.log(`cpus ${os.cpus().length}   loadavg at START ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
  console.log('')

  const { rules } = await loadGrammar(dialect, 'ast')
  loadedRules.set(dialect, rules)
  const rel = FIXTURE[dialect]
  const input = readFileSync(resolvePath(JESS_ROOT, rel), 'utf8')
  const { calls, fns } = record(dialect, input)

  const used = [...new Set(calls.map(c => c[0]))].sort((a, b) => a - b)
  const total = fns.filter(f => typeof f === 'function').length
  const arity = new Int8Array(fns.length)
  for (let i = 0; i < fns.length; i++) arity[i] = typeof fns[i] === 'function' ? (fns[i] as Builder).length : -1
  const buckets = new Map<number, number>()
  for (const i of used) buckets.set(arity[i]!, (buckets.get(arity[i]!) ?? 0) + 1)
  const hits = new Map<number, number>()
  for (const c of calls) hits.set(c[0], (hits.get(c[0]) ?? 0) + 1)

  console.log(`=== ${dialect}   ${rel}   ${Buffer.byteLength(input)} B`)
  console.log(`    fns entries (all kinds)          ${String(total)}`)
  console.log(`    builder invocations in ONE parse ${String(calls.length)}`)
  console.log(`    DISTINCT builders REALISED       ${String(used.length)}  <- the site's actual polymorphism`)
  console.log(`    builders by declared arity       ${[...buckets].sort((a, b) => a[0] - b[0]).map(([a, n]) => `${a}:${n}`).join('  ')}`)
  const top = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.log(`    top builders by call count       ${top.map(([i, n]) => `#${i}=${n}`).join('  ')}`)
  const head = top.reduce((s, [, n]) => s + n, 0)
  console.log(`    top-8 share of all invocations   ${(head / calls.length * 100).toFixed(1)}%`)
  console.log('')

  // DENSIFY. Every leg from here indexes a contiguous 0..used.length-1 array, so
  // no leg is charged for a sparse switch the real driver would never emit.
  const dense = new Map(used.map((i, n) => [i, n]))
  const dfns = used.map(i => fns[i])
  const darity = new Int8Array(used.map(i => arity[i]!))
  for (const c of calls) c[0] = dense.get(c[0])!
  const dhot = top.map(([i]) => dense.get(i)!)

  const mega = makeMega(dfns)
  const megaB = makeMega(dfns.slice())
  const arityLeg = makeArity(dfns, darity)
  const hot8 = makeHot8(dfns, dhot)
  const mono = makeMono(dfns, dfns.map((_f, n) => n))

  const mk = (f: (c: readonly Call[]) => void, tag: string): Case[] => [{
    id: rel, detail: `${tag} ${calls.length} calls`,
    parse: () => { f(calls) },
    run: (reps: number) => { for (let n = 0; n < reps; n++) f(calls) },
  }]
  const reps = new Map([[rel, 1]])
  const contests: Contest[] = [
    { label: 'MEGA -> MONO', a: mk(mega, 'mega'), b: mk(mono, 'mono') },
    { label: 'MEGA -> ARITY', a: mk(mega, 'mega'), b: mk(arityLeg, 'arity') },
    { label: 'MEGA -> HOT8', a: mk(mega, 'mega'), b: mk(hot8, 'hot8') },
    { label: 'CONTROL MEGA -> MEGA', a: mk(mega, 'mega'), b: mk(megaB, 'mega') },
  ]
  const out = interleave(contests, reps, M)
  const g = out.get('MEGA -> MONO')!
  const a = out.get('MEGA -> ARITY')!
  const h = out.get('MEGA -> HOT8')!
  const c = out.get('CONTROL MEGA -> MEGA')!
  const mm = median(g.get(`ref|${rel}`)!)
  const mo = median(g.get(`head|${rel}`)!)
  const ar = median(a.get(`head|${rel}`)!)
  const h8 = median(h.get(`head|${rel}`)!)
  console.log(`    ONE REPLAY of the recorded sequence, median of ${String(M.rounds * M.runs)} samples:`)
  console.log(`      MEGA  (exec.ts today) ${mm.toFixed(2).padStart(8)} ms`)
  console.log(`      MONO  (the ceiling)   ${mo.toFixed(2).padStart(8)} ms`)
  console.log(`      ARITY (the hypothesis)${ar.toFixed(2).padStart(8)} ms`)
  console.log(`      HOT8  (8 sites)       ${h8.toFixed(2).padStart(8)} ms`)
  const ctlA = median(c.get(`ref|${rel}`)!), ctlB = median(c.get(`head|${rel}`)!)
  console.log(`      CONTROL mega/mega ${sign((ctlB / ctlA - 1) * 100)} — this run's noise floor`)
  console.log('')
  console.log(`    CEILING, absolute:  MEGA - MONO = ${(mm - mo).toFixed(2)} ms of dispatch per parse`)
  console.log(`    ARITY buys:         MEGA - ARITY = ${(mm - ar).toFixed(2)} ms`)
  console.log(`    HOT8 buys:          MEGA - HOT8  = ${(mm - h8).toFixed(2)} ms`)
  console.log('')
  console.log(`loadavg at END ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
}

await main()
