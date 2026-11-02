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
  attempt, choice, compile, completionsAt, dispatch, keywords, label, literal, many, node, not, noTrivia, oneOrMore, oneOrMoreSep, optional, otherwise, parser, regex, routed, rules, sepBy, sequence, token,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { readers, seeded } from '../helpers/table-readers.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'

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

describe('a table rule with no trivia of its own, run inside a caller\'s trivia', () => {
  // The rule's entry installs no trivia, so its body runs under whatever its
  // caller has. Its gates are derived as 0.58.0 derived them there.
  const shapes: Record<string, Comb> = {
    choice: choice(sequence(pad, literal('*')), literal('x')),
    many: sequence(many(sequence(pad, literal('*'), num)), literal('!')),
    optional: sequence(optional(sequence(pad, literal('*'), num)), literal('!')),
    later: sequence(literal('a'), choice(sequence(pad, literal('*')), literal('x'))),
    list: sepBy(num, sequence(pad, literal(','))),
    // A gap that cannot match empty gives the item a first set, and a gap gate.
    spaced: sequence(num, many(sequence(regex(/ +/), literal('*'), num))),
    // A node at the body's start, where no trivia has been skipped.
    node: node('N', sequence(pad, literal('*'), num)),
    // A routed arm: the trivia after its token is not known, so it has no gate.
    routed: dispatch(word, otherwise(choice(sequence(routed(), literal(':'), word), sequence(routed(), literal('!'))))),
  }
  for (const [shape, body] of Object.entries(shapes)) {
    it(shape, () => {
      const E = rules(() => ({ E: body })).E as Comb
      // A table entry is a function of (input, pos, ctx), as a compiled parser's
      // context entry is; either stands in for E's own parse.
      type Parse = Comb['parse']
      const asParse = (e: unknown): Parse => (typeof e === 'function' ? e : (e as Comb).parse.bind(e)) as Parse
      const legs: Array<readonly [string, Parse]> = readers(encodeTable({ E })).map(([n, e]) => [n, asParse(e.E)] as const)
      const compiled = compile(E) as unknown as { parseWithContext: (input: string, ctx: unknown, pos: number) => ReturnType<Parse> }
      legs.push(['compile()', ((input, pos, ctx) => compiled.parseWithContext(input, ctx, pos)) as Parse] as const)
      for (const s of ['/*c*/*', '/*c*/*1!', ' /*c*/*1!', '*1!', '/*c*/!', 'x', '/*c*/x', 'a/*c*/*', 'a /*c*/*', 'a/*c*/x', '1,2', '1/*c*/,2', '1 /*c*/,2', '1 /*c*/*2', '1 *2 /*c*/ *3', 'a/*c*/:b', 'a:b', 'a /*c*/!', 'a/*c*/?']) {
        const input = `${s};`
        const want = result(parser({ trivia: comment }, sequence(E, literal(';'))), input, false)
        for (const [name, parse] of legs) {
          expect(result(parser({ trivia: comment }, sequence({ ...E, parse }, literal(';'))), input, false), `${name} ${JSON.stringify(input)}`).toBe(want)
        }
      }
    })
  }
})

describe('a gate through a reference from a cleared region takes the trivia it installs', () => {
  it('a routed arm whose next term is such a reference, and a choice arm that is one', () => {
    const g = rules({ trivia: comment }, (g: Record<string, Comb>) => ({
      S: noTrivia(sequence(literal('>'), choice(g.St!, g.C!, literal('x')), literal(';'))),
      R: noTrivia(sequence(literal('>'), g.St!, literal(';'))),
      St: dispatch(word, otherwise(choice(sequence(routed(), label('colon', g.Colon!)), sequence(routed(), literal('!'))))),
      Colon: sequence(optional(literal('+')), literal(':'), word),
      C: sequence(optional(literal('+')), literal('='), num),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['>a/*c*/:b;', '>a:b;', '>a/*c*/+:b;', '>a!;', '>/*c*/=1;', '>+=1;', '>/*c*/+=1;', '>x;']) {
        expect(result(entries.S!, input, false), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
        expect(result(entries.R!, input, false), `${name} R ${JSON.stringify(input)}`).toBe(result(g.R!, input, false))
      }
    }
  })

  it('a token\'s body runs under no trivia, so a reference inside it installs its rule\'s', () => {
    const g = rules({ trivia: comment }, (g: Record<string, Comb>) => ({
      S: sequence(literal('>'), token(sequence(literal('['), g.R!, literal(']'))), literal(';')),
      R: sequence(num, many(sequence(optional(literal(' ')), literal('+'), num))),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['>[1+2];', '>[1/*c*/+2];', '>[1 +2];', '>/*c*/[1+2];', '>[1+/*c*/2];', '>[1 /*c*/+2];']) {
        expect(result(entries.S!, input, false), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
      }
    }
  })
})

describe('a regex construct the first-set reader does not model is unknown, not its letter', () => {
  it('\\p{…}, \\cX and \\k<…> in a separator, a routed arm and a choice', () => {
    const g = rules((g: Record<string, Comb>) => ({
      List: sequence(sepBy(num, sequence(regex(/\p{Zs}*/u), literal(','))), literal(';')),
      St: dispatch(word, otherwise(choice(sequence(routed(), regex(/:\p{L}+/u), literal(';')), sequence(routed(), literal('!'), literal(';'))))),
      Pick: choice(regex(/\p{L}+/u), literal('1')),
      Ctl: choice(regex(/\cJ+/), regex(/(?<q>['"])x\k<q>/), literal('c')),
    })) as Record<string, Comb>
    const cases: Record<string, string[]> = {
      List: ['1,2;', '1 ,2;', '1;', '1,;'],
      St: ['a:b;', 'a:p;', 'a!;', 'a:;'],
      Pick: ['a', 'p', '1', 'é'],
      Ctl: ['\n', '"x"', "'x'", 'c', 'k'],
    }
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const [rule, inputs] of Object.entries(cases)) {
        for (const input of inputs) {
          expect(result(entries[rule]!, input, false), `${name} ${rule} ${JSON.stringify(input)}`).toBe(result(g[rule]!, input, false))
        }
      }
    }
    expect(run(g.Pick!, 'a').ok).toBe(true)
  })
})

describe('a construct encoded once for every scope it runs in', () => {
  it('a routed() fallback reached inside noTrivia and outside it', () => {
    const y = sequence(routed(sequence(num, many(sequence(pad, literal('*'), num)))), literal(';'))
    const g = rules({ trivia: comment }, () => ({ S: sequence(literal('['), noTrivia(sequence(literal('|'), y)), y, literal(']')) })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['[|1;1 /*c*/*2;]', '[|1 *2;1/*c*/*2;]', '[|1;1;]', '[|1 /*c*/*2;1;]']) {
        expect(result(entries.S!, input, false), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
      }
    }
  })
})

describe('a choice of another grammar over a reference that installs its rule\'s trivia', () => {
  // The interpreter's choice dispatches on the reference's construction-time set,
  // which does not read the trivia it installs; the table's classes keep the same
  // arms out (0.58.0's derivation).
  it('decides as the interpreter does', () => {
    const lib = rules({ trivia: comment }, (g: Record<string, Comb>) => ({ R: sequence(optional(literal('x')), literal('+'), num), Rr: g.R! })) as Record<string, Comb>
    const g = rules(() => ({ S: noTrivia(sequence(literal('>'), many(choice(literal('a'), lib.Rr!)), literal(';'))) })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['>/*c*/+1;', '>a/*c*/+1;', '>+1;', '>x/*c*/+1;', '>a;', '>/*c*/;']) {
        expect(result(entries.S!, input, false), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
      }
    }
  })
})

describe('where the interpreter tests a first set itself, the table tests the same one', () => {
  // The interpreter's choice dispatches, and its repeat, node and attempt guard,
  // on construction-time sets, which do not read a reference's installed trivia
  // or a pad's non-empty matches. Reached across two maps, where a reference is
  // defined when the wrapper is built, every reader must decide as it does.
  const body = (): Comb => sequence(optional(literal('x')), literal('+'), num)
  const shapes: Record<string, () => Comb> = {
    seq: body,
    choice: () => choice(body(), literal('y')),
    oneOrMore: () => oneOrMore(body()),
    sepBy: () => oneOrMoreSep(body(), literal(',')),
  }
  for (const [shape, make] of Object.entries(shapes)) {
    it(shape, () => {
      const lib = rules({ trivia: comment }, (g: Record<string, Comb>) => ({ R: make(), Touch: sequence(literal('!'), g.R!) })) as Record<string, Comb>
      const callers: Record<string, Comb> = {
        choice: rules(() => ({ S: sequence(literal('>'), many(choice(literal('a'), lib.R!)), literal(';')) })).S as Comb,
        bare: rules(() => ({ S: sequence(literal('>'), lib.R!, literal(';')) })).S as Comb,
        cleared: rules({ trivia: comment }, () => ({ S: noTrivia(sequence(literal('>'), many(choice(literal('a'), lib.R!)), literal(';'))) })).S as Comb,
        node: rules(() => ({ S: sequence(literal('>'), many(choice(literal('a'), node('W', lib.R!))), literal(';')) })).S as Comb,
        item: rules(() => ({ S: sequence(literal('>'), many(lib.R!), literal(';')) })).S as Comb,
        clearedItem: rules({ trivia: comment }, () => ({ S: noTrivia(sequence(literal('>'), many(lib.R!), literal(';'))) })).S as Comb,
        clearedNode: rules({ trivia: comment }, () => ({ S: noTrivia(sequence(literal('>'), node('W', lib.R!), literal(';'))) })).S as Comb,
        attempt: rules(() => ({ S: sequence(literal('>'), many(attempt(lib.R!)), literal(';')) })).S as Comb,
      }
      for (const [caller, S] of Object.entries(callers)) {
        for (const [name, entries] of readers(encodeTable({ S }))) {
          for (const input of ['>/*c*/+1;', '>+1;', '>x/*c*/+1;', '>a/*c*/+1;', '>/*c*/y;', '>+1,/*c*/+2;']) {
            for (const tolerant of [false, true]) {
              expect(result(entries.S!, input, tolerant), `${name} ${caller} ${JSON.stringify(input)} ${tolerant}`).toBe(result(S, input, tolerant))
            }
          }
        }
      }
    })
  }

  it('a node over a pad reports what entering it reports', () => {
    const g = rules({ trivia: regex(/[ \t]+/) }, () => ({
      S: sequence(word, node('N', sequence(pad, literal('b')))),
      A: sequence(word, attempt(sequence(pad, literal('b')))),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['a?', 'a b', 'ab', 'a', 'a  ?']) {
        expect(result(entries.S!, input, false), `${name} S ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
        expect(result(entries.A!, input, false), `${name} A ${JSON.stringify(input)}`).toBe(result(g.A!, input, false))
      }
    }
  })
})

describe('tolerant recovery resyncs where the interpreter does', () => {
  it('a choice whose arms open with pads, and a list reached across maps', () => {
    const hash = regex(/#[^\n]*\n/)
    const g = rules({ trivia: comment }, () => ({
      S: sequence(literal('>'), choice(sequence(num, literal('+'), pad), oneOrMoreSep(sequence(pad, literal(';')), literal(','))), literal('<')),
      E: sequence(literal('>'), choice(sequence(optional(sequence(pad, literal(';'))), literal(';')), num), literal('<')),
    })) as Record<string, Comb>
    const lib = rules({ trivia: hash }, (g: Record<string, Comb>) => ({
      R: sequence(oneOrMoreSep(literal('+'), literal(',')), oneOrMore(sequence(optional(literal('x')), literal(';')))),
      A: g.R!,
    })) as Record<string, Comb>
    const X = rules(() => ({ S: sequence(literal('>'), lib.R!, literal('<')) })).S as Comb
    for (const tolerant of [false, true]) {
      for (const [name, entries] of readers(encodeTable(g))) {
        for (const input of ['>,:<', '>1+<', '> ;,;<', '>;<', '>1+ <', '> <', '> ;;<', '>2<']) {
          expect(result(entries.S!, input, tolerant), `${name} S ${JSON.stringify(input)} ${tolerant}`).toBe(result(g.S!, input, tolerant))
          expect(result(entries.E!, input, tolerant), `${name} E ${JSON.stringify(input)} ${tolerant}`).toBe(result(g.E!, input, tolerant))
        }
      }
      for (const [name, entries] of readers(encodeTable({ S: X }))) {
        for (const input of ['>#c\n;<', '>#c\n+;<', '>+;<', '>#c\n;ba<', '>+,+x;<']) {
          expect(result(entries.S!, input, tolerant), `${name} X ${JSON.stringify(input)} ${tolerant}`).toBe(result(X, input, tolerant))
        }
      }
    }
  })
})


/** The emitted engine with its completion-probe assemblies precompiled (a build emits none by default). */
function probeEmitted(prog: TableProgram): Record<string, unknown> {
  const resolved = resolveTable(prog)
  const asm: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => ({ ...cfg, probe: true })).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory']
    return { key: cfgKey(cfg), factory, plan: out.plan, reached: [...out.reached] }
  })
  return tableRules({ ...prog, asm })
}

/** Every offset's completions through `entry` (a table reader's entry for `rule`), sorted and deduplicated. */
function completions(rule: Comb, entry: unknown, input: string): string[] {
  const target = typeof entry === 'function' ? { ...rule, parse: entry as Comb['parse'] } : entry as Comb
  return Array.from({ length: input.length + 1 }, (_, off) => JSON.stringify([...new Set(completionsAt(target, input, off))].sort()))
}

describe('a choice the interpreter tries arm by arm keeps every arm\'s failure', () => {
  it('a reference arm whose class its installed trivia widens does not make the dispatch exclusive', () => {
    const g = rules({ trivia: comment }, (g: Record<string, Comb>) => ({
      S: noTrivia(sequence(literal('>'), choice(literal('a'), g.R!, literal('b')), literal(';'))),
      R: sequence(not(literal('y')), literal('+'), num),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['>/', '>/x;', '>/*c*/+1;', '>+1;', '>a;', '>b;', '>?;', '>/*c*/?;']) {
        for (const tolerant of [false, true]) {
          expect(result(entries.S!, input, tolerant), `${name} ${tolerant} ${JSON.stringify(input)}`).toBe(result(g.S!, input, tolerant))
        }
        expect(completions(g.S!, entries.S, input), `${name} completions ${JSON.stringify(input)}`).toEqual(completions(g.S!, g.S, input))
      }
    }
  })

  it('under a completion probe, an ordered choice enters an arm its class excludes', () => {
    const g = rules(() => ({
      S: sequence(literal('>'), choice(literal('ab'), literal('ac'), literal('b')), literal(';')),
      T: sequence(literal('>'), choice(
        sequence(token(choice(literal('$.'), sequence(literal('$^'), word), sequence(literal('$'), word))), literal(';')),
        literal('$!'),
      )),
      U: sequence(literal('>'), token(choice(
        keywords(['@media']), keywords(['@supports']), keywords(['@layer']), regex(/@(?:-[a-z]+-)?keyframes/),
      )), literal(';')),
      // A dispatch miss beside an arm the probe enters: the interpreter runs
      // every arm on a miss, so each opener is a completion.
      V: sequence(literal('>'), choice(choice(literal('b'), literal('a')), oneOrMore(literal('a'))), literal('<')),
      W: sequence(literal('>'), choice(choice(literal('b'), literal('a')), word, literal('c')), literal('<')),
    })) as Record<string, Comb>
    const prog = encodeTable(g)
    for (const [name, entries] of [...readers(prog), ['emitted probe', probeEmitted(prog)] as const]) {
      for (const rule of ['S', 'T', 'U', 'V', 'W'] as const) {
        for (const input of ['>ax', '>a', '>b;', '>x', '>$', '>$1', '>', '>!', '>@foo', '><', '>c<', '>q<']) {
          expect(completions(g[rule]!, entries[rule], input), `${name} ${rule} ${JSON.stringify(input)}`).toEqual(completions(g[rule]!, g[rule], input))
        }
      }
    }
  })
})

describe('a tolerant list resyncs on its separator under the trivia live there', () => {
  it('a separator with an optional lead, in a comment map', () => {
    const g = rules({ trivia: comment }, () => ({
      S: sequence(literal('['), sepBy(regex(/[a-z0-9]+/), sequence(optional(literal(' ')), literal(','))), literal(']')),
    })) as Record<string, Comb>
    for (const [name, entries] of readers(encodeTable(g))) {
      for (const input of ['[/*c*//*c*/,,?and', '[/*c*/,,?', '[,,?', '[/*c*/,?', '[a/*c*/,,!;>/*c*/,,]', '[a,,]', '[a/*c*/,,]', '[a,/*c*/,]']) {
        expect(result(entries.S!, input, true), `${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, true))
      }
    }
  })
})

describe('a node gate reports what entering the node reports', () => {
  // A pad-led body: its first set read through the pad is finite, but a miss is
  // only known by running the body (`keyword`, a list's item set, an optional
  // lead the pad leaves unread). The gate keeps 0.58.0's derivation, so it is
  // laid down only where the body's own first set is finite.
  it('keywords, lists and an optional lead behind a pad, in strict mode', () => {
    const ws = regex(/[ \t]+/)
    const bodies: Record<string, () => Comb> = {
      keywords: () => sequence(regex(/[ \t]*/), keywords(['ab', 'cd'])),
      list: () => sepBy(sequence(regex(/[ \t]*/), literal(';')), literal(','), { min: 2 }),
      padList: () => sequence(regex(/[ \t]*/), sepBy(literal(';'), literal(','), { min: 2 })),
      optionalLead: () => sequence(regex(/[ \t]*/), optional(literal('x')), literal(';')),
    }
    for (const [shape, body] of Object.entries(bodies)) {
      for (const trivia of [ws, comment]) {
        const g = rules({ trivia }, () => ({ S: sequence(literal('>'), node('N', body()), literal('<')) })) as Record<string, Comb>
        for (const [name, entries] of readers(encodeTable(g))) {
          for (const input of ['>;<', '><', '>x;<', '>ab<', '> ab<', '>;,;<', '>?<']) {
            expect(result(entries.S!, input, false), `${shape} ${name} ${JSON.stringify(input)}`).toBe(result(g.S!, input, false))
          }
        }
      }
    }
  })
})

describe('the interpreter reads a reference under noTrivia as 0.58.0 did', () => {
  // `followSentinels` (sequence.ts) derive a resync class through `noTrivia(ref)`;
  // the install-through widening belongs to the table encoder only.
  it('a follow sentinel through noTrivia(<a rule of a comment map>)', () => {
    const lib = rules({ trivia: comment }, (g: Record<string, Comb>) => ({
      R0: many(sequence(literal(':'), literal(':'))),
      R1: label('L', sequence(g.R0!, optional(literal('x')))),
      A: g.R1!,
    })) as Record<string, Comb>
    const S = rules(() => ({
      S: sequence(literal('>'), oneOrMore(sequence(sepBy(literal('a'), literal(',')), noTrivia(lib.A!), literal(';'))), literal('<')),
    })).S as Comb
    const spans = (input: string) => (run(S, input, { tolerant: true }).errors ?? []).map(e => [e.span.start, e.span.end])
    expect(spans('>#/*c*/;<')).toEqual([[1, 7], [7, 9]])
    expect(spans('>q /*c*/;<')).toEqual([[1, 8], [8, 10]])
  })
})

describe('a list that ends under its minimum reports its item as the interpreter does', () => {
  // `repeat.ts` `failAt`: the item's derived set, or its tag where that derives
  // empty; a resync error carries the derived set as it is.
  it('an item whose derived set is empty, strict and tolerant', () => {
    for (const trivia of [undefined, comment]) {
      const g = rules(trivia === undefined ? {} : { trivia }, () => ({
        S: sequence(literal('>'), oneOrMoreSep(oneOrMoreSep(sequence(pad, literal(';')), literal(',')), literal(',')), literal('<')),
        T: sequence(literal('>'), oneOrMoreSep(oneOrMoreSep(literal(';'), literal(','), { min: 2 }), literal(',')), literal('<')),
      })) as Record<string, Comb>
      for (const [name, entries] of readers(encodeTable(g))) {
        for (const rule of ['S', 'T'] as const) {
          for (const input of ['>', '><', '>;<', '>;,;<', '>?<', '>;,?,;<', '>,<']) {
            for (const tolerant of [false, true]) {
              expect(result(entries[rule]!, input, tolerant), `${name} ${rule} ${tolerant} ${JSON.stringify(input)}`).toBe(result(g[rule]!, input, tolerant))
            }
          }
        }
      }
    }
  })
})
