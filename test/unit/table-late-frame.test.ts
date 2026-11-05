/**
 * A `node` with `collapse` over `sequence(corner, tail)`: parse the corner, look at the
 * next token, open the frame only if the tail can start there. Nothing marks the site;
 * the encoder lowers the shape it can prove, and every other shape runs as written.
 * The twin of each lowered site is the same node over a tail the encoder cannot read a
 * test from, which runs as written in every engine.
 */
import { describe, expect, it, vi } from 'vitest'
import { attempt, choice, classifiedTrivia, cstBuildHost, dispatch, field, literal, many, node, noTrivia, optional, otherwise, peek, regex, rules, sepBy, sequence, transform, when } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { OP_CONT } from '../../src/table/ops.ts'
import { reachableSites } from '../../src/table/site-labels.ts'
import { opHistogram } from '../../src/table/inspect.ts'
import { backtrackProbe } from '../../src/analysis/backtrack.ts'
import { expandCompact, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

type G = Record<string, Combinator<unknown>>

const bin = (type: string) => (children: readonly unknown[], _f: unknown, span: unknown) => ({ type, children, span })
const trivia = () => classifiedTrivia({ whitespace: regex(/[ \t\n\r\f]+/), comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//) })
const asWritten = <T>(tail: Combinator<T>): Combinator<T> => transform(tail, v => v)

const ladder = (twin = false, parentReadsRaw = false): G => {
  const wrap = (type: string, corner: Combinator<unknown>, tail: Combinator<unknown>): Combinator<unknown> =>
    node(type, sequence(corner, twin ? asWritten(tail) : tail), bin(type), { collapse: true })
  return rules({ trivia: trivia() }, (g: G) => ({
    Root: parentReadsRaw
      ? node('Decl', sequence(regex(/[a-z-]+/), literal(':'), g.Value!, literal(';')), (children, _f, span, raw) => ({ children, span, raw }))
      : node('Decl', sequence(regex(/[a-z-]+/), literal(':'), g.Value!, literal(';')), bin('Decl')),
    Value: wrap('Sequence', g.Sum!, many(g.Sum!)),
    Sum: wrap('Sum', g.Product!, many(sequence(regex(/[+-]/), g.Product!))),
    Product: wrap('Product', g.Atom!, many(sequence(regex(/[*/]/), g.Atom!))),
    Atom: node('Atom', regex(/[0-9a-z]+/), children => ({ atom: children[0] })),
  })) as G
}

const INPUTS = [
  'a:1;', 'a:1 + 2;', 'a:1 * 2 + 3;', 'a:1 2 3;', 'a:1 + 2 3 * 4;',
  'a:1 /* c */;', 'a:1 /* c */ + /* d */ 2;', 'a:1 /* c */ 2;', 'a:1 ;',
  'a:1 +;', 'a:1 + ;', 'a:;', 'a:', 'a:1', 'a:+;', 'a:1 * ;', 'a:1 ! 2;',
]

const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false }

const emittedOf = (prog: TableProgram): TableProgram => {
  const { asm: _none, ...rest } = prog
  return rest
}
const closureOf = (prog: TableProgram): TableProgram => ({ ...prog, asm: [] })
const cst = (g: G): TableProgram => encodeTable(g, { hostMode: 'cst' })

function frames(prog: TableProgram, input: string): number {
  const linked = assemble(resolveTable(prog), prog, CFG)
  const seen = new Set<unknown>()
  let n = 0
  const ctx = new Proxy(createParseContext(), {
    set(target, key, value) {
      if ((key === '_cstBuf' || key === '_cstChildren') && value !== undefined && !seen.has(value)) { seen.add(value); n++ }
      return Reflect.set(target, key, value)
    },
  }) as ParseContext
  linked.begin(ctx)
  linked.pieces.Root!(input, 0, ctx)
  linked.finish()
  return n
}

/** Whether the encoder lowered any site of this grammar. */
const hasLateFrame = (prog: TableProgram): boolean =>
  [...reachableSites(Int32Array.from(prog.code), Object.values(prog.rules))].some(ip => prog.code[ip] === OP_CONT)
const lowers = (g: G): boolean => hasLateFrame(encodeTable(g))

/** The four engines over one grammar, on every input, against the interpreter. */
function agree(g: G, inputs: readonly string[], opts: Parameters<typeof run>[2] = {}): void {
  const prog = encodeTable(g)
  const engines: [string, Parameters<typeof run>[0]][] = [
    ['reference', execRules(prog).Root!],
    ['closure', tableRules(closureOf(prog)).Root!],
    ['emitted', tableRules(emittedOf(prog)).Root!],
  ]
  for (const input of inputs) {
    const want = digestValue(run(g.Root!, input, opts))
    for (const [name, entry] of engines) expect(digestValue(run(entry, input, opts)), `${input} ${name}`).toBe(want)
  }
}

describe('a late frame', () => {
  it('lowers the ladder and not its twin', () => {
    expect(lowers(ladder())).toBe(true)
    expect(lowers(ladder(true))).toBe(false)
  })

  it('every engine builds what the interpreter builds', () => agree(ladder(), INPUTS))

  it('a program walker reaches the corner, the wrapper and the seed', () => {
    const ops = opHistogram(encodeTable(ladder()))
    expect(ops.CONT).toBeGreaterThan(0)
    expect(ops.SEED).toBe(ops.CONT)
    expect(backtrackProbe(ladder()).measure('Root', 'a:1 + 2 * 3;')).toBeDefined()
  })

  it('a parent that keeps raw children gets one raw child for the corner', () => agree(ladder(false, true), INPUTS))

  it('a tail that passes its test and takes nothing leaves the gap outside', () => {
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: node('Root', sequence(g.Inner!, optional(literal('+'))), bin('Root')),
      Inner: node('Inner', sequence(g.Sum!, optional(literal('+!'))), bin('Inner')),
      Sum: node('Sum', sequence(g.Atom!, many(literal('+='))), bin('Sum'), { collapse: true }),
      Atom: node('Atom', regex(/[0-9]+/), children => ({ atom: children[0] })),
    })) as G
    expect(lowers(g)).toBe(true)
    agree(g, ['1', '1 ', '1 +', '1 +!', '1 += +=', ' 1 += ', '1+='])
  })

  it('a CST host sees the same tree, trivia and spans as the node run as written', () => {
    const prog = cst(ladder())
    const twin = cst(ladder(true))
    for (const input of INPUTS) {
      const want = digestValue(run(tableRules(closureOf(twin)).Root!, input, { build: cstBuildHost }))
      expect(digestValue(run(tableRules(closureOf(prog)).Root!, input, { build: cstBuildHost })), `${input} closure`).toBe(want)
      expect(digestValue(run(tableRules(emittedOf(prog)).Root!, input, { build: cstBuildHost })), `${input} emitted`).toBe(want)
    }
  })

  it('recovery runs the node as written', () => {
    const prog = encodeTable(ladder())
    const twin = encodeTable(ladder(true))
    for (const input of INPUTS) {
      const want = digestValue(run(tableRules(closureOf(twin)).Root!, input, { tolerant: true }))
      expect(digestValue(run(tableRules(closureOf(prog)).Root!, input, { tolerant: true })), `${input} closure`).toBe(want)
      expect(digestValue(run(tableRules(emittedOf(prog)).Root!, input, { tolerant: true })), `${input} emitted`).toBe(want)
    }
  })

  for (const [engine, select] of [['emitted', emittedOf], ['closure', closureOf]] as const) {
    it(`${engine}: opens a frame only where the tail started`, () => {
      const count = (twin: boolean, input: string): number => frames(select(encodeTable(ladder(twin))), input)
      // `Decl` and `Atom` alone: Sequence, Sum and Product never open.
      expect(count(false, 'a:1;')).toBe(2)
      expect(count(true, 'a:1;')).toBe(5)
      // `Decl`, two `Atom`s and the one `Sum` that continued.
      expect(count(false, 'a:1 + 2;')).toBe(4)
    })
  }

  it('a builder runs only for a node that continued, and its start is the corner\'s', () => {
    const build = vi.fn(bin('Sum'))
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Sum: node('Sum', sequence(g.Atom!, many(sequence(literal('+'), g.Atom!))), build, { collapse: true }),
      Atom: node('Atom', regex(/[0-9]+/), (children, _f, span) => ({ atom: children[0], span })),
    })) as G
    const closure = tableRules(closureOf(encodeTable(g))).Sum!
    expect(run(closure, '1').ok).toBe(true)
    expect(build).not.toHaveBeenCalled()
    const r = run(closure, '1 + 2')
    expect(r.ok && (r.value as { span: { start: number; end: number } }).span).toMatchObject({ start: 0, end: 5 })
  })

  it('a trailing gap stays outside a corner with no tail', () => {
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: sequence(g.Sum!, literal(';')),
      Sum: node('Sum', sequence(g.Atom!, many(sequence(literal('+'), g.Atom!))), bin('Sum'), { collapse: true }),
      Atom: node('Atom', regex(/[0-9]+/), (children, _f, span) => ({ atom: children[0], span })),
    })) as G
    agree(g, ['1;', '1 ;', '1 + 2 ;', '1 + ;'])
  })
})

/**
 * What a lowered site leans on at run time. Each of these fails on the check that makes
 * it safe: a registered plant in `scripts/differential-defects.mjs` drops that check.
 */
describe('a site that lowers', () => {
  const sumOver = (opts: Parameters<typeof rules>[0]) => rules(opts, (g: G) => ({
    Root: sequence(g.Sum!, literal(';')),
    Sum: node('Sum', sequence(g.Atom!, many(sequence(literal('+'), g.Atom!))), bin('Sum'), { collapse: true }),
    Atom: atom(),
  })) as G
  const SUMS = ['1;', '1 ;', '1 + 2;', '1 + 2 ;', '1 +;', '  1  +  2  ;', '1 + ;']

  it('a trivia with no scanner runs as written', () => {
    const slowTrivia = () => many(choice(regex(/ /), regex(/\t/)))
    const g = sumOver({ trivia: slowTrivia() })
    expect(lowers(g)).toBe(true)
    agree(g, SUMS)
  })

  it('a scope the labels cannot name runs as written', () => {
    const noTriviaGrammar = sumOver({})
    expect(lowers(noTriviaGrammar)).toBe(true)
    agree(noTriviaGrammar, ['1;', '1+2;', '1+2+3;', '1+;', '1 +2;', '1;;'])
  })

  it('a corner that returned undefined published nothing, so its node is built', () => {
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: sequence(g.Sum!, literal(';')),
      Sum: node('Sum', sequence(g.Atom!, many(sequence(literal('+'), g.Atom!))), bin('Sum'), { collapse: true }),
      Atom: node('Atom', regex(/[0-9]+/), () => undefined),
    })) as G
    expect(lowers(g)).toBe(true)
    agree(g, SUMS)
    const prog = cst(g)
    for (const input of SUMS) {
      const want = digestValue(run(tableRules(closureOf(prog)).Root!, input, { build: cstBuildHost }))
      expect(digestValue(run(tableRules(emittedOf(prog)).Root!, input, { build: cstBuildHost })), input).toBe(want)
    }
  })

  it('a separated tail has no first test to read, so it runs as written', () => {
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: sequence(g.List!, literal(';')),
      List: node('List', sequence(g.Atom!, sepBy(g.Word!, literal(','))), bin('List'), { collapse: true }),
      Word: node('Word', regex(/[a-z]+/), children => ({ word: children[0] })),
      Atom: atom(),
    })) as G
    agree(g, ['1;', '1 a;', '1 a,b;', '1 a , b ;', '1 ,;', '1 a,;'])
  })

  it('a node without collapse always builds, so it runs as written', () => {
    const build = vi.fn(bin('Sum'))
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: sequence(g.Sum!, literal(';')),
      Sum: node('Sum', sequence(g.Atom!, many(sequence(literal('+'), g.Atom!))), build),
      Atom: atom(),
    })) as G
    expect(lowers(g)).toBe(false)
    agree(g, SUMS)
    build.mockClear()
    expect(run(tableRules(closureOf(encodeTable(g))).Root!, '1;').ok).toBe(true)
    expect(build).toHaveBeenCalledTimes(1)
  })

  /** The gap read to decide was not recorded, so a recording parse scans it again. */
  const recording = (parentCaptures: boolean) => rules({ trivia: trivia() }, (g: G) => ({
    Root: node('Root', sequence(g.Sum!, optional(literal('+!')), literal(';')), (children, _f, span, raw, log) => ({ children, span, raw, log }), parentCaptures ? { captureTrivia: true } : {}),
    Sum: node('Sum', sequence(g.Atom!, many(literal('+='))), (children, _f, span, raw, log) => ({ children, span, raw, log }), { collapse: true, captureTrivia: true }),
    Atom: node('Atom', regex(/[0-9]+/), children => children[0]),
  })) as G
  const RECORDED = ['1;', '1 /* a */;', '1 /* a */ += /* b */;', '1 /* a */ += /* b */ +=  ;', '1 /* a */ +! ;', '/* a */ 1 /* b */ +! /* c */;']

  it('a node that captures its gaps gets them whichever way it decided', () => {
    for (const parent of [false, true]) {
      expect(lowers(recording(parent))).toBe(true)
      agree(recording(parent), RECORDED)
    }
  })

  it('root trivia records the gap once, and takes it back from a tail that took nothing', () => {
    agree(ladder(), INPUTS, { rootTrivia: { select: ['comment'] } })
    agree(recording(false), RECORDED, { rootTrivia: { select: ['comment'] } })
  })

  it('a raw parent over an undefined corner, with the gap recorded', () => {
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: node('Root', sequence(g.Sum!, optional(literal('+!')), literal(';')), (children, _f, span, raw, log) => ({ children, span, raw, log })),
      Sum: node('Sum', sequence(g.Atom!, many(literal('+='))), (children, _f, span, raw, log) => ({ children, span, raw, log }), { collapse: true, captureTrivia: true }),
      Atom: node('Atom', regex(/[0-9]+/), () => undefined),
    })) as G
    expect(lowers(g)).toBe(true)
    agree(g, RECORDED)
    agree(g, RECORDED, { rootTrivia: { select: ['comment'] } })
  })
})

/**
 * What the encoder must not prove. Each corner returns something other than the one
 * node it published, or publishes something other than one node, so the frame's first
 * child is not the corner's value and the node runs as written.
 */
const CORNER_INPUTS = ['1;', '1}', '1 ;', '1 + 2', '1 + 2 + 3', 'k 1', 'k 1 + 2', 'z', 'z + 1', '+', '1 +', 'k', '', '1 2', 'k +', '1+2', ' 1 ', '1 /* c */ + 2']

const atom = () => node('Atom', regex(/[0-9]+/), (children, _f, span) => ({ atom: children[0], span }))
const sum = (corner: Combinator<unknown>, g: G) =>
  node('Sum', sequence(corner, many(sequence(literal('+'), g.Atom!))), bin('Sum'), { collapse: true })

const SHAPES: Record<string, () => G> = {
  'a transform over a node': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: sum(transform(g.Atom!, a => ({ mapped: a })), g),
    Atom: atom(),
  })) as G,
  'a dispatch whose selector publishes': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: sum(dispatch(
      transform(node('Key', regex(/[kz]/), children => ({ key: children[0] })), () => 'k'),
      when('k', g.Atom!),
      otherwise(g.Atom!),
    ), g),
    Atom: atom(),
  })) as G,
  'a sequence corner': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: sum(sequence(g.Atom!, g.Atom!), g),
    Atom: atom(),
  })) as G,
  'a leaf corner': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: sum(regex(/[0-9]+/), g),
    Atom: atom(),
  })) as G,
  'a choice with one arm that is not a node': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: sum(choice(g.Atom!, literal('z')), g),
    Atom: atom(),
  })) as G,
  'a named separator tail': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: node('List', sequence(g.Atom!, sequence(field('separator', regex(/,/)), g.Atom!)), bin('List'), { collapse: true }),
    Atom: atom(),
  })) as G,
  'a required tail that reads as nullable through a lookahead': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: node('Item', sequence(g.Atom!, choice(literal(';'), peek(literal('}')))), bin('Item'), { collapse: true }),
    Atom: atom(),
  })) as G,
  'a required tail that reads as nullable through an attempt': () => rules({ trivia: trivia() }, (g: G) => ({
    Root: node('Item', sequence(g.Atom!, attempt(sequence(literal('+'), g.Atom!))), bin('Item'), { collapse: true }),
    Atom: atom(),
  })) as G,
}

describe('a shape that cannot be proved', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    it(`${name} runs as written and every engine agrees`, () => {
      expect(lowers(make())).toBe(false)
      agree(make(), CORNER_INPUTS)
    })
  }

  it('the proof reads the corner through references and arms', () => {
    const g = rules({ trivia: trivia() }, (g: G) => ({
      Root: sum(choice(g.Atom!, noTrivia(g.Word!)), g),
      Word: node('Word', regex(/[a-z]+/), children => ({ word: children[0] })),
      Atom: atom(),
    })) as G
    expect(lowers(g)).toBe(true)
    agree(g, CORNER_INPUTS)
  })

  const macroProgram = (corner: string): TableProgram => {
    const src = `
import { many, node, regex, rules, sequence, literal, transform } from 'parseman' with { type: 'macro' }
export const g = rules({ trivia: regex(/ +/) }, (g) => ({
  Root: node('Sum', sequence(${corner}, many(sequence(literal('+'), g.Atom))), (children) => ({ sum: children.length }), { collapse: true }),
  Atom: node('Atom', regex(/[0-9]+/), (children) => ({ atom: children[0] })),
}))
`
    let seen: Parameters<typeof tableRules>[0] | undefined
    evalMacroModule(transformMacro(src, '/virtual/ladder.ts', new Set(['parseman']))!.code, 'g', { tableRules: (p: Parameters<typeof tableRules>[0]) => { seen = p } })
    return expandCompact(seen!)
  }

  it('the macro lowers what the runtime lowers and refuses what it refuses', () => {
    expect(hasLateFrame(macroProgram('g.Atom'))).toBe(true)
    expect(hasLateFrame(macroProgram('transform(g.Atom, (a) => ({ mapped: a }))'))).toBe(false)
  })
})
