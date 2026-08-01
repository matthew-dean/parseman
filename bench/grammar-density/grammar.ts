/**
 * Rollback-density grammars — the workload parseman's microbenchmarks do not have.
 *
 * `perf:guard` measures a 47-byte `css/decls` and a 34-byte `css/selector`. Both
 * are shallow: they execute the speculative-rollback paths (`not`, `attempt`,
 * `choice` arms, `many` items, `sepBy` items) a handful of times per KB. Real
 * grammars execute them hundreds of times per KB, and that is where 0.34.0's
 * unconditional capture-buffer truncations landed — invisible to a microbenchmark,
 * +25% on a real one.
 *
 * So this file is not trying to look like CSS. It is one grammar shape,
 * instantiated at three ROLLBACK DENSITIES, over one shared input. The shape and
 * the input are held constant; only the number of speculative probes per byte
 * moves. That isolates exactly the axis the regression rides on, and the spread
 * across the three is the signal — a per-execution cost shows up as an ordering
 * (sparse < medium < dense), while a per-site or per-input cost does not.
 *
 * The densities are chosen to bracket the measured `not()`-per-KB of the three
 * real grammars in the 0.34.0 event (css 20, jess 121, less 599), so the gate
 * spans the range where the regression went from −1.6% to +25.5%.
 *
 * Every case builds nodes with trivia capture. That is not decoration: the
 * emitted rollback is gated on `_ctx.capturing`, and the truncations themselves
 * are gated on each sink being non-null at run time. A grammar with no `node()`
 * would compile the rollback away entirely and measure nothing.
 */
import {
  node, regex, literal, sequence, choice, many, oneOrMore, optional, not, attempt,
  parser, trivia, rules,
  type Combinator,
} from '../../src/index.ts'

export type DensityNode = {
  type: string
  span: { start: number; end: number }
  children: unknown[]
  rawCount: number
  triviaLen: number
}

function mk(
  type: string,
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
): DensityNode {
  return {
    type,
    span: { start: span.start, end: span.end },
    children: [...children],
    rawCount: rawChildren.length,
    triviaLen: triviaLog.length,
  }
}

const ws = regex(/[ \t\n\r\f]+/)
const comment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)
const rw = trivia(oneOrMore(choice(ws, comment)))

const ident = regex(/[_a-zA-Z][-_a-zA-Z0-9]*/)
const num = regex(/\d*\.\d+|\d+/)
const unit = regex(/[a-zA-Z%]+/)
const hex = regex(/#[0-9a-fA-F]{3,8}/)
const str = regex(/"(?:[^"\\]|\\.)*"/)

/**
 * The probe alphabet. Each entry is a literal the guarded position never starts
 * with, so every `not()` SUCCEEDS — which is the common, hot outcome: the inner
 * parse fails cheaply and the rollback runs on buffers whose length never moved.
 * That is precisely the case the unconditional `length` store made expensive, and
 * the case a guard on `length !== mark` makes free.
 *
 * They are deliberately one and two characters and mutually distinct, so the cost
 * measured is the PROBE, not the literal match behind it.
 */
const PROBES = [
  '@@', '$$', '^^', '~~', '``', '\\\\', '||', '&&', '!!', '??',
  '<<', '>>', '::', ';;', ',,', '..', '++', '--', '**', '//',
  '§', '¶', '¤', '¦', '¬', '°', '±', 'µ', '·', '¿',
] as const

/** `n` negative lookaheads in front of a position none of them can match. */
function guards(n: number): Array<Combinator<unknown>> {
  if (n > PROBES.length) throw new RangeError(`density ${n} exceeds the probe alphabet (${PROBES.length})`)
  return PROBES.slice(0, n).map(p => not(literal(p)))
}

/**
 * `sequence` infers a NON-EMPTY tuple from its rest parameter, which a spread of
 * a dynamically built `Combinator[]` cannot satisfy. Both density grammars build
 * their term list at runtime, so split the head off explicitly — the emptiness
 * check is what makes the tuple provable, so no assertion is needed.
 */
function seqOf(...terms: Combinator<unknown>[]): Combinator<unknown> {
  const [first, ...rest] = terms
  if (first === undefined) throw new RangeError('seqOf requires at least one term')
  return sequence(first, ...rest)
}

/**
 * One grammar, parameterised by how many negative lookaheads guard each value
 * term. `attempt` around the declaration adds the other rollback shape (a
 * six-sink transactional restore) so the gate is not a `not()`-only probe: the
 * 0.34.0 fix touched 33 emission sites, and a gate that only watches one of them
 * will pass the next regression in the other 32.
 */
export function densityGrammar(guardsPerValue: number): Combinator<unknown> {
  const g = guards(guardsPerValue)

  const { Stylesheet } = rules((r: {
    Stylesheet: Combinator<unknown>
    Rule: Combinator<unknown>
    Declaration: Combinator<unknown>
    Value: Combinator<unknown>
    Dimension: Combinator<unknown>
  }) => {
    const Stylesheet = node('Stylesheet',
      parser({ trivia: rw }, many(r.Rule)),
      (c, _f, s, raw, tl) => mk('Stylesheet', c, raw, s, tl))

    const Rule = node('Rule',
      parser({ trivia: rw }, sequence(
        oneOrMore(ident),
        literal('{'),
        many(r.Declaration),
        literal('}'),
      )),
      (c, _f, s, raw, tl) => mk('Rule', c, raw, s, tl))

    // `attempt` so a failed declaration rolls the whole transaction back rather
    // than leaving half a capture behind — the six-sink restore shape.
    const Declaration = node('Declaration',
      attempt(parser({ trivia: rw }, sequence(
        ident,
        literal(':'),
        oneOrMore(r.Value),
        literal(';'),
      ))),
      (c, _f, s, raw, tl) => mk('Declaration', c, raw, s, tl))

    // The guards sit in front of every value term, so density scales with the
    // value count of the input rather than with the rule count.
    const Value = parser({ trivia: rw }, seqOf(...g, choice(r.Dimension, hex, str, ident)))

    const Dimension = node('Dimension',
      sequence(num, optional(unit)),
      (c, _f, s, raw, tl) => mk('Dimension', c, raw, s, tl))

    return { Stylesheet, Rule, Declaration, Value, Dimension }
  })

  return Stylesheet
}

/**
 * The shared input. Held identical across densities so the only moving part is
 * the probe count — a per-density input would confound "more probes" with "more
 * bytes". ~64 KB, which is large enough for a stable median and small enough that
 * the whole gate finishes in seconds.
 */
export function densityInput(rules = 700): string {
  const props = ['color', 'background', 'border-width', 'margin', 'font-family', 'padding-left', 'z-index', 'opacity']
  const values = ['12px', '#ff8800', '1.5em', 'inherit', '"quoted value"', '0', '100%', 'solid', '3.25rem']
  const out: string[] = []
  for (let i = 0; i < rules; i++) {
    const sel = `sel-${i} child-${i % 17}`
    const decls: string[] = []
    for (let d = 0; d < 6; d++) {
      const prop = props[(i + d) % props.length]!
      const v1 = values[(i * 3 + d) % values.length]!
      const v2 = values[(i * 5 + d * 2) % values.length]!
      decls.push(`  ${prop}: ${v1} ${v2};`)
    }
    if (i % 9 === 0) decls.push('  /* a comment, so trivia capture is exercised */')
    out.push(`${sel} {\n${decls.join('\n')}\n}`)
  }
  return `${out.join('\n\n')}\n`
}

/**
 * The SECOND axis: how wide the derived `expected` set is at a choice that loses
 * every arm.
 *
 * The rollback sweep above watches probes-per-byte, because that is the axis
 * 0.34.0's regression rode. It would not have caught 0.35.0's, which rode this
 * one — `fix(expect)` deriving through a nullable prefix widened the derived sets
 * on jess's Less grammar and cost 32% of parse time, with the rollback cases
 * reading flat. A gate parameterised on one axis only ever catches that axis.
 *
 * The shape: a value is a choice whose arms each begin with a NULLABLE prefix,
 * and every arm's prefix starts from the SAME operand alphabet. Deriving through
 * the prefix therefore re-reaches those tokens once per optional term, per arm.
 * The emitted total-failure path is `_ctx._fx = [...arm0, ...arm1, …]`, so the
 * arrays materialised there scale with the derived width — and each one feeds the
 * ENCLOSING choice's concat, which is why the cost compounds rather than adds.
 *
 * This choice is deliberately NOT first-character-disjoint, and cannot be made so
 * without deleting the thing it measures: a shared nullable prefix is precisely
 * what makes the derivation re-reach the same tokens, and arms gated on distinct
 * first characters have nothing to re-reach. The repo's disjoint-gating guidance
 * is about grammars written to be fast; this is a fixture written to reproduce a
 * shape a real grammar has (jess's Less value position) and did regress on.
 *
 * The non-disjoint dispatch it implies is not a confound. The gate A/Bs a case
 * against ITSELF across two parseman builds, so any fixed arm-selection cost is
 * present on both sides and cancels; and `narrow` (1 optional term) versus `wide`
 * (4) holds the dispatch shape identical while moving only the derived width, so
 * the width reading does not have to be taken against the disjoint `none`.
 *
 * `prefixDepth` is that width knob. The SHARED input already drives the losing
 * path — `oneOrMore(Value)` ends every declaration by failing `Value` on the `;`,
 * which is an all-arms-failed choice per declaration, six per rule. No separate
 * input is needed, and using the same one keeps the two axes comparable.
 */
export function expectedWidthGrammar(prefixDepth: number): Combinator<unknown> {
  // One shared operand alphabet behind every optional term — the duplication is
  // the point. `attempt` keeps a losing value from tearing the capture.
  const operand = choice(literal('~'), literal('^'), literal('&'), literal('|'))
  const prefix: Array<Combinator<unknown>> = []
  for (let i = 0; i < prefixDepth; i++) prefix.push(optional(operand))

  const { Stylesheet } = rules((r: {
    Stylesheet: Combinator<unknown>
    Rule: Combinator<unknown>
    Declaration: Combinator<unknown>
    Value: Combinator<unknown>
    Dimension: Combinator<unknown>
  }) => {
    const Stylesheet = node('Stylesheet',
      parser({ trivia: rw }, many(r.Rule)),
      (c, _f, s, raw, tl) => mk('Stylesheet', c, raw, s, tl))

    const Rule = node('Rule',
      parser({ trivia: rw }, sequence(
        oneOrMore(ident),
        literal('{'),
        many(r.Declaration),
        literal('}'),
      )),
      (c, _f, s, raw, tl) => mk('Rule', c, raw, s, tl))

    const Declaration = node('Declaration',
      attempt(parser({ trivia: rw }, sequence(
        ident,
        literal(':'),
        oneOrMore(r.Value),
        literal(';'),
      ))),
      (c, _f, s, raw, tl) => mk('Declaration', c, raw, s, tl))

    // Each arm: the nullable prefix, then that arm's own terminal.
    const arm = (tail: Combinator<unknown>): Combinator<unknown> => seqOf(...prefix, tail)
    const Value = parser({ trivia: rw }, choice(
      arm(r.Dimension), arm(hex), arm(str), arm(ident),
    ))

    const Dimension = node('Dimension',
      sequence(num, optional(unit)),
      (c, _f, s, raw, tl) => mk('Dimension', c, raw, s, tl))

    return { Stylesheet, Rule, Declaration, Value, Dimension }
  })

  return Stylesheet
}

/**
 * The gate's cases, across BOTH axes.
 *
 * `rollback/*` — speculative probes per byte. The conversion is MEASURED, not
 * estimated: instrumenting the emitted artifact and parsing `densityInput(200)`
 * (37.7 KB) counts 3,556 / 14,224 / 56,896 `not()` executions at
 * `guardsPerValue` 1 / 4 / 16, i.e. **94 per KB per guard** — 0 / 94 / 377 /
 * 1508. The interpreter counts identically, so the figure is not engine-specific.
 *
 * Against the real grammars in the 0.34.0 event — css 20, jess 121, less 599 per
 * KB — every one of them lands INSIDE this sweep: css between `none` and
 * `sparse`, jess between `sparse` and `medium`, less between `medium` and
 * `dense`, with `dense` sitting 2.5x above the worst of them. An earlier version
 * of this comment claimed `× 42`, which made `dense` look like ~672/KB and less
 * like a grammar at the edge of the bracket; it was not, and a `rollback/extreme`
 * case added on that premise has been removed rather than kept for reassurance.
 * Recheck this constant if the input generator changes.
 *
 * `expected/*` — derived expected-set width at a choice that loses every arm.
 * `none` is the disjoint-arm baseline (no nullable prefix at all, so first-char
 * dispatch is O(1)); `narrow` and `wide` both carry a nullable prefix and so
 * share the same dispatch shape, differing ONLY in how many times the derivation
 * re-reaches the operand alphabet. Reading `narrow` against `wide` therefore
 * isolates width; reading either against `none` also picks up the dispatch
 * change, which is why `none` is a baseline and not the control.
 */
export const DENSITY_CASES = [
  { id: 'rollback/none', kind: 'rollback', n: 0 },
  { id: 'rollback/sparse', kind: 'rollback', n: 1 },
  { id: 'rollback/medium', kind: 'rollback', n: 4 },
  { id: 'rollback/dense', kind: 'rollback', n: 16 },
  { id: 'expected/none', kind: 'expected', n: 0 },
  { id: 'expected/narrow', kind: 'expected', n: 1 },
  { id: 'expected/wide', kind: 'expected', n: 4 },
] as const

export type DensityCase = (typeof DENSITY_CASES)[number]

/** The grammar for one case — the gate never picks a shape itself. */
export function caseGrammar(c: { kind: string; n: number }): Combinator<unknown> {
  return c.kind === 'expected' ? expectedWidthGrammar(c.n) : densityGrammar(c.n)
}

/** The input for one case. Held constant within an axis. */
export function caseInput(_c: { kind: string }, rules: number): string {
  return densityInput(rules)
}
