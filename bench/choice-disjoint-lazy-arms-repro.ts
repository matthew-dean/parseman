/**
 * REPRO — the interpreter loses O(1) first-char dispatch on any choice whose
 * arms are `g.X` references.
 *
 * `choice()` decides `disjoint` at CONSTRUCTION from `p._meta.firstSet`
 * (`src/combinators/choice.ts:35`), and builds its ASCII dispatch table only if
 * that is true (`:62`, consumed at `:90`). A `rules()` arm is a lazy proxy whose
 * shallow first set is `any` until the map is closed, so `areDisjoint` reports
 * false and the dispatch table is never built — for exactly the choices an
 * author gated most carefully.
 *
 * TWO GRAMMARS, ONE LANGUAGE. Identical arms, identical trees; the only
 * difference is whether the arms are written directly or through `g.`. If the
 * flag were sound they would be the same speed.
 *
 * SCOPE, verified separately and stated so this is not overclaimed:
 *   - CODEGEN IS NOT AFFECTED. The emitted artifact recomputes deep first sets
 *     and emits a real `if (_code === 123) … else if (_code === 91) …` chain.
 *     Verified in /tmp/pm-disjoint/g.out.js.
 *   - `diagnoseGrammar` IS NOT LYING. It reports `gates: "recoverable"` with
 *     `ok: true` and no finding — a named third state, not a false alarm.
 *   - So this is an INTERPRETER PERFORMANCE defect only. No mis-parse: ordered
 *     first-match returns the same arm, it just tries them one at a time.
 */
import os from 'node:os'
import { choice, literal, regex, rules, sequence, transform, type Combinator } from '../src/index.ts'
import { interleave, median, type Case, type Contest, type Measurement, sign } from './ab-harness.ts'
import { run } from '../src/functional/run.ts'
import { PARSEMAN_VERSION } from '../src/version.ts'
import type { ParserDef } from '../src/types.ts'

const M: Measurement = { targetSampleMs: 20, warmup: 4, timed: 7, rounds: 8, runs: 2 }

const A = transform(sequence(literal('{'), regex(/[a-z]*/), literal('}')), v => ['A', (v as string[])[1]])
const B = transform(sequence(literal('['), regex(/[a-z]*/), literal(']')), v => ['B', (v as string[])[1]])
const C = transform(sequence(literal('<'), regex(/[a-z]*/), literal('>')), v => ['C', (v as string[])[1]])
const D = transform(sequence(literal('('), regex(/[a-z]*/), literal(')')), v => ['D', (v as string[])[1]])
const E = transform(regex(/[0-9]+/), v => ['E', v])
const F = transform(regex(/[a-z]+/), v => ['F', v])

/** Arms written DIRECTLY: `disjoint` is decided over resolved first sets. */
const direct: Combinator<unknown> = choice(A, B, C, D, E, F)

/** The same arms reached through `g.`: `disjoint` is decided over `any`. */
const viaRefs = rules<Record<string, Combinator<unknown>>>(g => ({
  A, B, C, D, E, F,
  Item: choice(g.A!, g.B!, g.C!, g.D!, g.E!, g.F!),
})) as unknown as Record<string, Combinator<unknown>>

/**
 * THE CONFOUND CONTROL, and why the `direct -> via g.` number alone cannot carry
 * the claim.
 *
 * That contest changes TWO things at once: the choice loses its dispatch table,
 * AND every arm is now reached through a lazy proxy's `thunk()` rather than
 * directly. Some of the delta is the second thing, and nothing in the pairing
 * separates them.
 *
 * This grammar is `viaRefs` with the arms REORDERED so the one the input hits
 * (`F`, the `[a-z]+` arm) is tried FIRST. It pays the identical lazy-reference
 * overhead per arm and has the identical non-disjoint flag; the only difference
 * is how many arms are attempted before the match. `viaFirst -> viaRefs` is
 * therefore the ordered-first-match cost ALONE, with lazy deref held constant —
 * and the residue between it and `direct -> via g.` is the lazy overhead.
 */
const viaRefsTargetFirst = rules<Record<string, Combinator<unknown>>>(g => ({
  A, B, C, D, E, F,
  Item: choice(g.F!, g.A!, g.B!, g.C!, g.D!, g.E!),
})) as unknown as Record<string, Combinator<unknown>>

function unwrap(c: Combinator<unknown>): Combinator<unknown> {
  let x = c
  while (x._def.tag === 'lazy') x = (x._def as { thunk: () => Combinator<unknown> }).thunk()
  return x
}

// The input leads with the LAST arm's first char, so ordered first-match pays
// for five misses per item and dispatch pays for none.
const ITEM = 'zzzz'
const INPUTS: Array<[string, string]> = [
  ['items/64', Array.from({ length: 64 }, () => ITEM).join(' ')],
  ['items/512', Array.from({ length: 512 }, () => ITEM).join(' ')],
]

type Entry = Parameters<typeof run>[0]

function many(entry: Combinator<unknown>): Entry {
  return entry as unknown as Entry
}

function cases(entry: Entry, texts: Array<[string, string]>): Case[] {
  return texts.map(([id, text]) => ({
    id,
    detail: `${text.length} B`,
    // Parse each item independently: this measures the CHOICE, not a wrapper.
    parse: () => { let n = 0; for (const w of text.split(' ')) n += run(entry, w).ok ? 1 : 0; return n },
    run: (reps: number) => {
      const words = text.split(' ')
      for (let i = 0; i < reps; i++) for (const w of words) run(entry, w)
    },
  }))
}

function calibrateReps(cs: readonly Case[]): Map<string, number> {
  const reps = new Map<string, number>()
  for (const c of cs) {
    for (let n = 0; n < 5; n++) c.parse()
    const ts: number[] = []
    for (let n = 0; n < 9; n++) {
      const t0 = performance.now()
      c.parse()
      ts.push(performance.now() - t0)
    }
    reps.set(c.id, Math.max(1, Math.round(M.targetSampleMs / Math.max(median(ts), 0.01))))
  }
  return reps
}

function main(): void {
  console.log(`parseman ${PARSEMAN_VERSION}   ${process.cwd()}   node ${process.version}`)
  console.log(`  loadavg ${os.loadavg().map(n => n.toFixed(1)).join(' ')}`)
  console.log('')

  const dd = direct._def as ParserDef
  const rd = unwrap(viaRefs.Item!)._def as ParserDef
  console.log(`  direct  choice: disjoint = ${dd.tag === 'choice' ? dd.disjoint : 'n/a'}`)
  console.log(`  via g.  choice: disjoint = ${rd.tag === 'choice' ? rd.disjoint : 'n/a'}   <- SAME ARMS`)
  console.log('')

  const dEntry = many(direct)
  const rEntry = many(viaRefs.Item!)
  const fEntry = many(viaRefsTargetFirst.Item!)
  for (const [, text] of INPUTS) {
    for (const w of text.split(' ')) {
      const a = JSON.stringify(run(dEntry, w).value)
      const b = JSON.stringify(run(rEntry, w).value)
      const c = JSON.stringify(run(fEntry, w).value)
      if (a !== b || a !== c) { console.error('ABORT: the grammars parse differently'); process.exit(1) }
    }
  }
  console.log('  same-parse precondition: OK — identical trees, so this is speed only')

  const reps = calibrateReps(cases(dEntry, INPUTS))
  const contests: Contest[] = [
    { label: 'CONTROL  direct -> direct', a: cases(dEntry, INPUTS), b: cases(many(choice(A, B, C, D, E, F)), INPUTS) },
    { label: 'REPRO    direct -> via g.', a: cases(dEntry, INPUTS), b: cases(rEntry, INPUTS) },
    // Lazy on BOTH sides: isolates the arms-tried cost from the lazy-deref cost.
    { label: 'ISOLATE  via g. first -> via g. last', a: cases(fEntry, INPUTS), b: cases(rEntry, INPUTS) },
  ]
  const out = interleave(contests, reps, M)
  console.log('')
  for (const k of contests) {
    const s = out.get(k.label)!
    const parts: string[] = []
    for (const [id] of INPUTS) {
      const a = s.get(`ref|${id}`)!, b = s.get(`head|${id}`)!
      parts.push(`${id.padEnd(10)} min ${sign((Math.min(...b) / Math.min(...a) - 1) * 100).padStart(8)}`)
    }
    console.log(`  ${k.label.padEnd(36)} ${parts.join('  ')}`)
  }
  console.log('')
  console.log('  positive = the `g.`-referenced form is SLOWER for the same parse.')
  console.log('  REPRO carries dispatch loss AND lazy-deref cost; ISOLATE holds lazy constant,')
  console.log('  so ISOLATE is the arms-tried cost alone and REPRO - ISOLATE is the deref residue.')
}

main()
