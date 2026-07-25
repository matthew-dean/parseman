/**
 * THE differential guardrail: the interpreter and the compiled output must be
 * indistinguishable through every observable a caller can reach.
 *
 * The rule here is WHOLE-OBJECT equality, never a field checklist. Every parity
 * bug this repo has shipped got through a harness that compared a SUBSET:
 *
 *   - `bothEngines` compared `ok`, and then `value`/`span.end` only when BOTH
 *     engines succeeded — so a failure whose `expected` array and `span.start`
 *     differed between engines passed silently (sepBy `trailing: 'require'`).
 *   - the recovery harness compared the value tree and `_errors`, but was only
 *     ever pointed at default-option lists, so a new option's recovery path was
 *     never differentially exercised at all.
 *   - `not()` leaked the global `_triviaLog` on BOTH engines identically, so an
 *     engine-vs-engine check agreed while both were wrong — which is why
 *     `expectTriviaLogGolden` (an absolute assertion) has to sit alongside the
 *     relative one.
 *
 * A field checklist can only catch the differences someone already thought of,
 * and it silently fails to cover any field added later. `toEqual` on the whole
 * result cannot: a new field in ParseResult is compared the day it appears.
 * If a divergence is genuinely legitimate, normalize it HERE, explicitly and
 * with a reason — never by narrowing what the assertion looks at.
 */
import { expect } from 'vitest'
import { compile, parse as runtimeParse, run } from '../../../src/index.ts'
import { REC } from '../../../src/recovery/scan.ts'
import type { Combinator, ParseContext } from '../../../src/index.ts'

/** Sinks a parse can write besides its return value. All must match too. */
type Sinks = {
  triviaLog: number[]
  cstLeaves: unknown[]
  errors: unknown[]
}

/**
 * The ONE legitimate asymmetry, normalized explicitly rather than by narrowing
 * the assertion: a compile whose grammar contains no `node()` emits NO capture
 * code whatsoever (codegen's `capturing` flag — it is what keeps non-CST
 * grammars compiling byte-identically). The interpreter has no such compile-time
 * gate: hand it a ctx with `_cstLeaves` and it captures regardless. Seeding the
 * CST sinks for a non-capturing compile would therefore compare the
 * interpreter's dynamic capture against compiled silence and report a
 * divergence on every input — a design difference, not a defect.
 *
 * `_triviaLog` is gated the same way (the emitted trivia fn is only called with
 * `_cap = 1` under `capturing`), so it travels with the CST sinks. `_errors` is
 * driven by `recovery`, not `capturing`, so it is always compared.
 *
 * Detected from the emitted source itself rather than by re-deriving "does this
 * tree contain a node()" — the compiled output is the ground truth for what the
 * compiled engine will actually write.
 */
function freshSinks(captures: boolean): { sinks: Sinks; ctx: ParseContext } {
  const sinks: Sinks = { triviaLog: [], cstLeaves: [], errors: [] }
  const ctx = {
    trackLines: false,
    ...(captures ? { _triviaLog: sinks.triviaLog, _cstLeaves: sinks.cstLeaves } : {}),
    _errors: sinks.errors,
  } as unknown as ParseContext
  return { sinks, ctx }
}

export type ParityOptions = {
  /** Also compare a tolerant/recovery run (value tree AND the ParseError set). */
  tolerant?: boolean
  /** Ambient trivia for the tolerant `run()` comparison. */
  trivia?: Combinator<unknown>
  /** Compile with recovery emitted (required for the tolerant comparison). */
  recovery?: boolean
}

/**
 * Assert the two engines agree COMPLETELY on `input`.
 *
 * Compares the entire ParseResult (ok, value, span.start, span.end, and the
 * `expected` array on failure) plus every context sink the parse can write.
 * Returns the interpreted result so a caller can additionally assert the
 * ABSOLUTE behaviour — parity alone cannot catch a bug both engines share.
 */
export function assertEnginesAgree<T>(
  c: Combinator<T>,
  input: string,
  opts: ParityOptions = {},
): ReturnType<typeof runtimeParse<T>> {
  const compiled = compile(c, undefined, { gating: 'off', ...(opts.recovery ? { recovery: true } : {}) })

  const captures = compiled.source.includes('_cstLeaves')
  const i = freshSinks(captures)
  const k = freshSinks(captures)
  const interpreted = c.parse(input, 0, i.ctx)
  const compiledResult = compiled.parseWithContext(input, k.ctx, 0)

  // WHOLE object — not a field checklist. See the header.
  expect(compiledResult, `compiled result must equal interpreted for ${JSON.stringify(input)}`)
    .toEqual(interpreted)
  expect(k.sinks, `compiled context sinks must equal interpreted for ${JSON.stringify(input)}`)
    .toEqual(i.sinks)

  if (opts.tolerant) {
    const ri = run(c, input, opts.trivia ? { tolerant: true, trivia: opts.trivia } : { tolerant: true })
    const errors: unknown[] = []
    const tctx = { trackLines: false, _errors: errors, _tolerant: true, _rec: REC } as unknown as ParseContext
    const rc = compiled.parseWithContext(input, tctx, 0) as { ok: boolean; value: unknown }
    expect(
      { ok: rc.ok, value: rc.value, errors },
      `tolerant compiled must equal tolerant interpreted for ${JSON.stringify(input)}`,
    ).toEqual({ ok: ri.ok, value: ri.value, errors: ri.errors })
  }

  return runtimeParse(c, input)
}

/** `assertEnginesAgree` across a list of inputs. */
export function assertEnginesAgreeAll<T>(
  c: Combinator<T>,
  inputs: readonly string[],
  opts: ParityOptions = {},
): void {
  for (const input of inputs) assertEnginesAgree(c, input, opts)
}
