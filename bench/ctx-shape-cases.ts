/**
 * The cases the ctx-shape A/B measures.
 *
 * This module is COPIED into each side's materialised directory, so its
 * `../src/...` import resolves to that side's parseman while the case
 * definitions stay identical. That is the whole point: the comparison must be
 * of the compiler, not of the benchmark's history.
 *
 * ## Why this is not just another `perf:workloads` row
 *
 * The broad gate drives every workload with
 * `compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0)` —
 * a `ParseContext` the BENCHMARK builds. It therefore never constructs one
 * through the runtime, and a change to how the runtime constructs `ctx` is
 * invisible to it by construction. Every case here enters through `run()`,
 * which is where `ctx` is actually built.
 *
 * The three configurations are the ones the shape change is claimed over:
 *   run/ast          the ordinary path, where the trivia fields used to be ABSENT
 *   run/triviaLog    per-node trivia capture, where they used to be PRESENT
 *   run/rootTrivia   selected root trivia — the configuration a previous lane
 *                    measured at +52% with `delete`, and the one whose `ctx`
 *                    `bench/ctx-shape-probe.ts` found in DICTIONARY MODE at the
 *                    base commit
 *
 * The grammar is `workloads/less-classified.ts`: the broad gate's real Less
 * grammar with labelled trivia. It has to be a grammar that actually PARSES the
 * corpus — an earlier revision of this file used a toy grammar that failed
 * immediately, which made every case a measurement of `run()`'s fixed per-call
 * cost and produced a meaningless -62%. `buildCases` asserts the parse succeeds
 * so that cannot recur silently.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, run } from '../src/index.ts'
import { Stylesheet, rw } from './workloads/less-classified.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'workloads', 'fixtures')

/**
 * Repeat the corpus until it passes `targetKB`, renaming identifiers per copy so
 * the parse cannot be shortcut by repetition. Same approach the broad gate uses.
 */
function scale(corpus: string, targetKB: number): string {
  const out: string[] = []
  let size = 0
  for (let n = 0; size < targetKB * 1024; n++) {
    const copy = n === 0
      ? corpus
      : corpus.replace(/([.#@])([a-zA-Z][-a-zA-Z0-9]*)/g, (_m, lead: string, name: string) => `${lead}s${n}x${name}`)
    out.push(copy)
    size += copy.length
  }
  return out.join('\n')
}

export type Case = { id: string; bytes: number; make: () => { parse: () => unknown } }

export function buildCases(): Case[] {
  const input = scale(readFileSync(path.join(FIXTURES, 'app.less'), 'utf8'), 48)

  const entry = (): ((i: string, p: number, ctx: never) => unknown) => {
    const c = compile(Stylesheet)
    return (i, p, ctx) => c.parseWithContext(i, ctx, p)
  }

  const cases: Case[] = [
    {
      id: 'run/ast',
      bytes: input.length,
      make: () => {
        const e = entry()
        return { parse: () => run(e as never, input, { trivia: rw as never }) }
      },
    },
    {
      id: 'run/triviaLog',
      bytes: input.length,
      make: () => {
        const e = entry()
        return { parse: () => run(e as never, input, { trivia: rw as never, triviaCaptureMask: 0 } as never) }
      },
    },
    {
      id: 'run/rootTrivia',
      bytes: input.length,
      make: () => {
        const e = entry()
        return {
          parse: () => run(e as never, input, {
            trivia: rw as never,
            rootTrivia: { select: ['blockComment', 'lineComment'] },
          } as never),
        }
      },
    },
  ]

  // A failing parse is not a workload. Both sides would agree on the failure and
  // the gate would happily report a large, meaningless delta on `run()`'s fixed
  // cost. Refuse instead.
  for (const c of cases) {
    const r = c.make().parse() as { ok: boolean; unconsumedFrom: number | null }
    if (!r.ok || r.unconsumedFrom !== null) {
      throw new Error(
        `ctx-shape-cases: ${c.id} did not parse the corpus (ok=${r.ok}, unconsumedFrom=${r.unconsumedFrom}).`
        + ' Measuring a failed parse measures nothing.',
      )
    }
  }
  return cases
}
