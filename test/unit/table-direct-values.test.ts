/**
 * DIRECT VALUES, against the closure engine and the collector protocol.
 *
 * A direct-values assembly passes a node's children as two locals (`ks`/`rs`)
 * instead of collectors on the context (`emit-assembly.ts`,
 * `DIRECT_RUNTIME_PRELUDE`). Three legs build each grammar from one encoded
 * table and must agree on the whole `RunResult` — value, span, `ok`, expected
 * set — for every input, accepted and rejected:
 *
 *   - `direct`: the emitted assembly with direct values, whole and selective (a
 *     hybrid with closure pieces, so both adapters run);
 *   - `collectors`: the same emitted assembly on the collector protocol;
 *   - `closure`: the closure engine (`asm: []`).
 *
 * Each leg says what it is: the direct source must carry the entry adapter and
 * the collector source must not. Each input also runs behind a caller that hands
 * in a collector of its own (a capture buffer, flat arrays, or one of
 * `_cstChildren`/`_cstLeaves` alone), which is what the entry adapter converts:
 * there the direct assembly must leave the caller's collector exactly as the
 * collector protocol does.
 *
 * `pnpm check:differentials` plants a dropped push, a skipped rollback and a
 * wrong truncation in the direct lowering and requires this file to go red.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { run } from '../../src/functional/run.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { digestValue } from '../../src/oracle/index.ts'
import type { ParseContext } from '../../src/types.ts'
import { SUITES, legs, type Suite, type TableRule } from './table-direct-values-cases.ts'

/** The collectors a caller may hold when it calls into an assembly. */
const CALLERS: Record<string, () => Partial<ParseContext>> = {
  'buffer': () => ({ _cstBuf: {} }),
  'count-only buffer': () => ({ _cstBuf: { noRaw: true, rawLen: 0 }, captureTrivia: true }),
  'flat': () => { const a: unknown[] = []; return { _cstChildren: a, _cstLeaves: a, _cstRawChildren: [] } },
  'children only': () => ({ _cstChildren: [] }),
  'leaves only': () => ({ _cstLeaves: [], _cstRawChildren: [] }),
}

/**
 * What a caller's collector ended up holding, read the way a node frame reads its
 * buffer when it closes (`finishCstBuf`): which lazy slot holds a lone child is
 * the buffer's own bookkeeping, not content.
 */
function collected(ctx: ParseContext): unknown {
  const b = ctx._cstBuf
  const buf = b === undefined ? undefined : {
    children: b.ch ?? (b.single !== undefined ? [b.single] : []),
    raw: b.noRaw === true ? b.rawLen : b.raw ?? (b.rawSingle !== undefined ? [b.rawSingle] : []),
    triviaLog: b.tl ?? [],
  }
  return [buf, ctx._cstChildren, ctx._cstLeaves, ctx._cstRawChildren, ctx._cstTriviaLog, ctx._triviaLog]
}

function agree({ grammar, entry, cases, opts = {} }: Suite): void {
  const prog = encodeTable(grammar)
  const es = legs(prog, entry)
  // A suite whose every input fails (or none does) tests one path only.
  const oks = cases.map(({ input }) => run(es.closure as never, input, opts).ok)
  expect(oks.some(Boolean), `${entry}: some input parses`).toBe(true)
  for (const { name, input } of cases) {
    const want = digestValue(run(es.closure as never, input, opts))
    for (const [leg, rule] of Object.entries(es)) {
      expect(digestValue(run(rule as never, input, opts)), `${entry} ${name}: ${leg}`).toBe(want)
    }
    for (const [caller, make] of Object.entries(CALLERS)) {
      const outcome = (rule: TableRule | undefined): string => {
        const ctx = { ...createParseContext(), trivia: opts.trivia as never, _triviaLog: [], ...make() } as unknown as ParseContext
        const r = rule!(input, 0, ctx)
        return digestValue([r, collected(ctx)])
      }
      // What a caller's collector holds afterwards is each engine's own business
      // on a rejected input (the caller rolls it back), and the closure engine
      // and the emitted assembly already differ there. Direct values replace the
      // emitted assembly's protocol, so they answer to it, result and collector.
      const base = outcome(es.collectors)
      expect(outcome(es.direct), `${entry} ${name}: direct behind a ${caller} caller`).toBe(base)
      const result = (rule: TableRule | undefined): string =>
        digestValue(rule!(input, 0, { ...createParseContext(), trivia: opts.trivia as never, ...make() } as unknown as ParseContext))
      expect(result(es['direct+closure']), `${entry} ${name}: direct+closure behind a ${caller} caller`).toBe(result(es.closure))
    }
  }
}

describe('direct values agree with the closure engine and the collector protocol', () => {
  for (const suite of SUITES) it(suite.name, () => agree(suite))
})
