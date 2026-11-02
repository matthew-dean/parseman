/**
 * Gates and first sets see the trivia that is live where they run.
 *
 * A first set derived through a nullable term takes in the trivia that may be
 * skipped after it, and a gate built from that set is only right under that
 * trivia. Two things decide it, and the table must see both as the interpreter
 * does:
 *
 * - THROUGH A REFERENCE. A rule referenced from a region that cleared trivia runs
 *   under its own (`ref.ts`, `Encoder.scopedRef`), so a repeat in the cleared
 *   region gates its items with the rule's trivia, not the region's.
 * - PER SCOPE. One rule body reached under two scopes (an entry with none, and
 *   the same rule under a caller's trivia) runs under each, so it is encoded
 *   under each.
 *
 * Each grammar below has the gates this covers: a gap gate, an optional-literal
 * lead, a separator, and a routed arm. Every reader must give the interpreter's
 * whole result, and its expected set, over generated inputs with comments in
 * every gap, strict and tolerant.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, compile, dispatch, literal, many, noTrivia, optional, otherwise, parser, regex, routed, rules, sepBy, sequence,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { readers, seeded } from '../helpers/table-readers.ts'

type Comb = Combinator<unknown>

const comment = regex(/\/\*[^*]*\*\//)
const pad = regex(/[ \t]*/)
const num = regex(/[0-9]+/)
const word = regex(/[a-z]+/)

/** Rule bodies with no trivia of their own: the scope comes from whoever runs them. */
const bare = (): Record<string, Comb> => rules((g: Record<string, Comb>) => ({
  Gap: sequence(num, many(sequence(pad, literal('+'), num))),
  // A gap that cannot match empty: the item's first set is the gap's own.
  Spaced: sequence(num, many(sequence(regex(/[ \t]+/), literal('-'), num))),
  Opt: sequence(num, many(sequence(optional(literal(' ')), literal('*'), num))),
  List: sepBy(num, sequence(pad, literal(','), pad)),
  Routed: dispatch(word, otherwise(choice(
    sequence(routed(), literal(':'), num),
    sequence(routed(), literal('::'), num),
    sequence(routed(), literal('!')),
  ))),
  All: sequence(g.Gap!, literal('|'), g.Spaced!, literal('|'), g.Opt!, literal('|'), g.List!, literal('|'), g.Routed!),
})) as Record<string, Comb>

/** A routed arm in a rule with no trivia, run under a caller's comment trivia. */
function routedGrammar(): Record<string, Comb> {
  const inner = rules(() => ({
    St: dispatch(word, otherwise(choice(
      sequence(routed(), literal(':'), word),
      sequence(routed(), literal('::'), word),
      sequence(routed(), literal('!')),
    ))),
  })) as Record<string, Comb>
  const outer = rules({ trivia: comment }, () => ({ S: sequence(literal('>'), inner.St!, literal(';')) })) as Record<string, Comb>
  return { St: inner.St!, S: outer.S!, T: outer.S! }
}

const routedInput = (gap: () => string, rnd: (n: number) => number): string =>
  `>${gap()}${['a', 'bc'][rnd(2)]}${gap()}${[':b', '::b', '!', ':', '::', ': b'][rnd(6)]}${gap()};`

/** The same bodies under a caller's comment trivia. */
function callerGrammar(): Record<string, Comb> {
  const inner = bare()
  const S = parser({ trivia: comment }, sequence(literal('>'), inner.All!, literal(';')))
  return { ...inner, S, T: S }
}

/**
 * A cleared region whose repeat items are rules of a trivia map. `T` is `S`
 * without the separated list, for the tolerant leg: a tolerant list resyncs to
 * its separator's first set as a class, which cannot say that a pad-led
 * separator (a comment, then a comma) starts only where its comma follows, while the
 * interpreter runs the separator itself (`orSentinel`). 0.58.0 differs from the
 * interpreter there the same way.
 */
const clearedGrammar = (): Record<string, Comb> => rules({ trivia: comment }, (g: Record<string, Comb>) => ({
  S: noTrivia(sequence(literal('>'), g.Gap!, literal('|'), g.Opt!, literal('|'), g.List!, literal(';'))),
  T: noTrivia(sequence(literal('>'), g.Gap!, literal('|'), g.Opt!, literal('|'), regex(/\[[^\]]*\]/), literal(';'))),
  Gap: noTrivia(sequence(num, many(g.GapOp!))),
  GapOp: sequence(pad, literal('+'), num),
  Opt: noTrivia(sequence(num, many(g.OptOp!))),
  OptOp: sequence(optional(literal(' ')), literal('*'), num),
  List: noTrivia(sequence(literal('['), sepBy(word, g.Comma!), literal(']'))),
  Comma: sequence(pad, literal(','), pad),
})) as Record<string, Comb>

function inputs(seed: number, body: (gap: () => string, rnd: (n: number) => number) => string, n = 300): string[] {
  const rnd = seeded(seed)
  const gap = (): string => ['', ' ', '  ', '/*c*/', ' /*c*/', '/*c*/ ', ' /*c*/ '][rnd(7)]!
  const out = new Set<string>()
  for (let i = 0; i < 4 * n && out.size < n; i++) {
    const ok = body(gap, rnd)
    out.add(ok)
    const at = rnd(ok.length)
    out.add([ok.slice(0, at), `${ok.slice(0, at)}?${ok.slice(at)}`, ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return [...out]
}

const chain = (op: string, gap: () => string, rnd: (n: number) => number): string => {
  let s = String(rnd(10))
  for (let i = rnd(4); i > 0; i--) s += `${gap()}${op}${gap()}${String(rnd(10))}`
  return s
}

const callerInput = (gap: () => string, rnd: (n: number) => number): string => {
  const list = Array.from({ length: 1 + rnd(3) }, () => String(rnd(10))).join(`${gap()},${gap()}`)
  const tail = [':1', '::2', '!', ':', ':: 3'][rnd(5)]!
  return `>${gap()}${chain('+', gap, rnd)}${gap()}|${gap()}${chain('-', gap, rnd)}${gap()}|${gap()}${chain('*', gap, rnd)}${gap()}|${gap()}${list}${gap()}|${gap()}ab${gap()}${tail}${gap()};`
}

const clearedInput = (gap: () => string, rnd: (n: number) => number): string => {
  const list = Array.from({ length: 1 + rnd(3) }, () => ['a', 'bc'][rnd(2)]!).join(`${gap()},${gap()}`)
  return `>${chain('+', gap, rnd)}|${chain('*', gap, rnd)}|[${list}];`
}

function result(entry: Runnable, input: string, tolerant: boolean): string {
  const r = run(entry, input, tolerant ? { tolerant: true } : {})
  return `${digestValue(r)} ${JSON.stringify(r.ok ? null : r.expected)}`
}
type Runnable = Parameters<typeof run>[0]

describe('gates and first sets see the trivia live where they run', () => {
  const cases: ReadonlyArray<readonly [string, () => Record<string, Comb>, string[], ReadonlyArray<string>]> = [
    ['a routed arm in a rule with no trivia, under its caller\'s trivia', routedGrammar, inputs(5, routedInput, 150), []],
    // The bodies are entries with no trivia, encoded before the caller reaches them.
    ['a rule body under its caller\'s trivia, encoded first as an entry', callerGrammar, inputs(7, callerInput), []],
    // The caller is encoded first, so the bodies are first reached under its trivia.
    ['a rule body under its caller\'s trivia, reached first from the caller', callerGrammar, inputs(11, callerInput), ['S']],
    ['repeat items that are rules of a trivia map, in a cleared region', clearedGrammar, inputs(13, clearedInput), []],
  ]
  for (const [label, make, cases_, first] of cases) {
    for (const tolerant of [false, true]) {
      it(`${label}${tolerant ? ' (tolerant)' : ''}`, () => {
        const g = make()
        const ordered: Record<string, Comb> = {}
        for (const k of first) ordered[k] = g[k]!
        for (const [k, v] of Object.entries(g)) ordered[k] ??= v
        expect(cases_.length).toBeGreaterThan(120)
        const entry = tolerant ? 'T' : 'S'
        const want = cases_.map(input => result(g[entry]!, input, tolerant))
        for (const [name, entries] of readers(encodeTable(ordered))) {
          cases_.forEach((input, i) => {
            expect(result(entries[entry]!, input, tolerant), `${name} ${JSON.stringify(input)}`).toBe(want[i])
          })
        }
      }, 60_000)
    }
  }
})

describe('a gap gate holds only where no trivia runs', () => {
  it('one repeat reached inside noTrivia and outside it, in one rule map', () => {
    const ops = many(sequence(regex(/ +/), literal('+'), num))
    const g = rules({ trivia: comment }, () => ({
      S: sequence(noTrivia(sequence(literal('['), ops, literal(']'))), num, ops, literal(';')),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['[ +1]2 /*c*/+3;', '[ +1 +2]2 +3 /*c*/ +4;', '[]2;', '[ +1]2/*c*/ +3;']) {
        expect(result(entries.S!, input, false), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
      }
    }
  })

  it('a compiled rule run under a caller\'s trivia', () => {
    const E = rules(() => ({ E: sequence(num, many(sequence(regex(/[ ]*/), literal('+'), num))) })).E as Comb
    const compiled = compile(E) as unknown as { parse: Comb['parse'] }
    const viaInterpreter = parser({ trivia: comment }, sequence(literal('a'), E, literal(';')))
    const viaCompiled = parser({ trivia: comment }, sequence(literal('a'), { ...E, parse: compiled.parse }, literal(';')))
    for (const input of ['a1 /*c*/+2;', 'a1/*c*/ +2;', 'a1 +2;', 'a1;']) {
      expect(result(viaCompiled, input, false), JSON.stringify(input)).toBe(result(viaInterpreter, input, false))
    }
  })
})

describe('a choice at a position where trivia has not been skipped', () => {
  it('enters an arm led by a nullable pad, in every engine', () => {
    // The interpreter's choice dispatches on the construction-time first set,
    // which cannot know the trivia; a table gate that rejects the arm reports
    // what entering it reports.
    const g = rules({ trivia: comment }, () => ({ S: choice(sequence(pad, literal('*')), literal('x')) })) as Record<string, Comb>
    expect(run(g.S!, '/*c*/*').ok).toBe(true)
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['/*c*/*', '*', ' *', 'x', '', '?', '/*c*/x']) {
        expect(result(entries.S!, input, false), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
      }
    }
  })
})
