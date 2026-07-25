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
    const Value = parser({ trivia: rw }, sequence(...g, choice(r.Dimension, hex, str, ident)))

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
 * The gate's cases. Named for what they are — a probe count — not for a dialect.
 *
 * `guardsPerValue` → probes/KB is roughly `guardsPerValue × 42` on this input
 * (12 value terms per ~285-byte rule). The three land near 42 / 126 / 630,
 * bracketing the 20 / 121 / 599 measured across css / jess / less.
 */
export const DENSITY_CASES = [
  { id: 'rollback/none', guardsPerValue: 0 },
  { id: 'rollback/sparse', guardsPerValue: 1 },
  { id: 'rollback/medium', guardsPerValue: 4 },
  { id: 'rollback/dense', guardsPerValue: 16 },
] as const
