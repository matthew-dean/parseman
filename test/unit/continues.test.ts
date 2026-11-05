/**
 * `continues(type, corner, tail, build)`: parse the corner, look at the next token,
 * open the wrapper only if the tail can start there. A precedence ladder, as a value
 * grammar spells one. Every engine builds the same value, span and error as the same
 * node written with `collapse`, and a corner with nothing after it opens no frame.
 */
import { describe, expect, it, vi } from 'vitest'
import { classifiedTrivia, continues, cstBuildHost, field, literal, many, node, noTrivia, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { transformMacro } from '../../src/plugin/index.ts'

const bin = (type: string) => (children: readonly unknown[], _f: unknown, span: unknown) => ({ type, children, span })

const ladder = (form: 'continues' | 'collapse'): Record<string, Combinator<unknown>> => {
  const wrap = (type: string, corner: Combinator<unknown>, tail: Combinator<unknown>): Combinator<unknown> =>
    form === 'continues'
      ? continues(type, corner, tail, bin(type))
      : node(type, sequence(corner, tail), bin(type), { collapse: true })
  return rules({ trivia: classifiedTrivia({ whitespace: regex(/[ \t\n\r\f]+/), comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//) }) }, (g: Record<string, Combinator<unknown>>) => ({
    Root: node('Decl', sequence(regex(/[a-z-]+/), literal(':'), g.Value!, literal(';')), bin('Decl')),
    Value: wrap('Sequence', g.Sum!, many(g.Sum!)),
    Sum: wrap('Sum', g.Product!, many(sequence(regex(/[+-]/), g.Product!))),
    Product: wrap('Product', g.Atom!, many(sequence(regex(/[*/]/), g.Atom!))),
    Atom: node('Atom', regex(/[0-9a-z]+/), children => ({ atom: children[0] })),
  })) as Record<string, Combinator<unknown>>
}

const INPUTS = [
  'a:1;', 'a:1 + 2;', 'a:1 * 2 + 3;', 'a:1 2 3;', 'a:1 + 2 3 * 4;',
  'a:1 /* c */;', 'a:1 /* c */ + /* d */ 2;', 'a:1 /* c */ 2;', 'a:1 ;',
  'a:1 +;', 'a:1 + ;', 'a:;', 'a:', 'a:1', 'a:+;', 'a:1 * ;', 'a:1 ! 2;',
]

const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false }

function emittedOf(prog: TableProgram): TableProgram {
  const { asm: _none, ...rest } = prog
  return rest
}
const cst = (g: Record<string, Combinator<unknown>>): TableProgram => encodeTable(g, { hostMode: 'cst' })
const closureOf = (prog: TableProgram): TableProgram => ({ ...prog, asm: [] })

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

describe('continues', () => {
  it('every engine parses as the same node written with collapse', () => {
    const classic = ladder('collapse')
    const g = ladder('continues')
    const prog = encodeTable(g)
    const engines: [string, Parameters<typeof run>[0]][] = [
      ['interpreter', g.Root!],
      ['reference', execRules(prog).Root!],
      ['closure', tableRules(closureOf(prog)).Root!],
      ['emitted', tableRules(emittedOf(prog)).Root!],
    ]
    for (const input of INPUTS) {
      const want = digestValue(run(classic.Root!, input))
      for (const [name, entry] of engines) expect(digestValue(run(entry, input)), `${input} ${name}`).toBe(want)
    }
  })

  it('a CST host sees the same tree, trivia and spans', () => {
    const classic = ladder('collapse')
    const prog = cst(ladder('continues'))
    for (const input of INPUTS) {
      const want = digestValue(run(tableRules(closureOf(cst(classic))).Root!, input, { build: cstBuildHost }))
      expect(digestValue(run(tableRules(closureOf(prog)).Root!, input, { build: cstBuildHost })), `${input} closure`).toBe(want)
      expect(digestValue(run(tableRules(emittedOf(prog)).Root!, input, { build: cstBuildHost })), `${input} emitted`).toBe(want)
    }
  })

  it('recovery and a probe run the node as written', () => {
    const classic = ladder('collapse')
    const prog = encodeTable(ladder('continues'))
    for (const input of INPUTS) {
      const want = digestValue(run(tableRules(encodeTable(classic)).Root!, input, { tolerant: true }))
      expect(digestValue(run(tableRules(prog).Root!, input, { tolerant: true })), input).toBe(want)
    }
  })

  for (const [engine, select] of [['emitted', emittedOf], ['closure', closureOf]] as const) {
    it(`${engine}: opens a wrapper only where the tail started`, () => {
      const ladderFrames = (form: 'continues' | 'collapse', input: string): number => frames(select(encodeTable(ladder(form))), input)
      // `Decl` and `Atom` alone: Sequence, Sum and Product never open.
      expect(ladderFrames('continues', 'a:1;')).toBe(2)
      expect(ladderFrames('collapse', 'a:1;')).toBe(5)
      // `Decl`, two `Atom`s and the one `Sum` that continued.
      expect(ladderFrames('continues', 'a:1 + 2;')).toBe(4)
    })
  }

  it('a builder runs only for a node that continued, and its start is the corner\'s', () => {
    const build = vi.fn(bin('Sum'))
    const g = rules({ trivia: regex(/ +/) }, (g: Record<string, Combinator<unknown>>) => ({
      Sum: continues('Sum', g.Atom!, many(sequence(literal('+'), g.Atom!)), build),
      Atom: node('Atom', regex(/[0-9]+/), (children, _f, span) => ({ atom: children[0], span })),
    })) as Record<string, Combinator<unknown>>
    const closure = tableRules(closureOf(encodeTable(g))).Sum!
    expect(run(closure, '1').ok).toBe(true)
    expect(build).not.toHaveBeenCalled()
    const r = run(closure, '1 + 2')
    expect(r.ok && (r.value as { span: { start: number; end: number } }).span).toMatchObject({ start: 0, end: 5 })
  })

  it('a one-child node that means something keeps node(): a corner that is not one node is refused', () => {
    const g = rules({}, (_g: Record<string, Combinator<unknown>>) => ({
      Sum: continues('Sum', regex(/[0-9]+/), many(sequence(literal('+'), regex(/[0-9]+/))), bin('Sum')),
    })) as Record<string, Combinator<unknown>>
    expect(() => encodeTable(g)).toThrow(/corner must publish exactly one node and return it/)
    const t = rules({}, (g: Record<string, Combinator<unknown>>) => ({
      Sum: continues('Sum', g.Atom!, sequence(literal('+'), g.Atom!), bin('Sum')),
      Atom: node('Atom', regex(/[0-9]+/), children => ({ atom: children[0] })),
    })) as Record<string, Combinator<unknown>>
    expect(() => encodeTable(t)).toThrow(/tail must be able to take nothing/)
  })

  it('a comma list spelled with a named separator does not open for one item', () => {
    const list = (): Record<string, Combinator<unknown>> => rules({}, (g: Record<string, Combinator<unknown>>) => ({
      Root: continues('List', g.Atom!, many(sequence(field('separator', regex(/,[ \t]*/)), g.Atom!)), bin('List')),
      Atom: node('Atom', regex(/[0-9]+/), children => ({ atom: children[0] })),
    })) as Record<string, Combinator<unknown>>
    expect(frames(closureOf(encodeTable(list())), '1')).toBe(1)
    expect(frames(closureOf(encodeTable(list())), '1, 2')).toBe(3)
  })

  it('the macro lowers it the same way', () => {
    const src = `
import { continues, many, node, regex, rules, sequence, literal } from 'parseman' with { type: 'macro' }
export const g = rules({ trivia: regex(/ +/) }, (g) => ({
  Sum: continues('Sum', g.Atom, many(sequence(literal('+'), g.Atom)), (children) => ({ sum: children.length })),
  Atom: node('Atom', regex(/[0-9]+/), (children) => ({ atom: children[0] })),
}))
`
    const out = transformMacro(src, '/virtual/ladder.ts', new Set(['parseman']))
    const code = typeof out === 'string' ? out : out?.code
    expect(code).toBeDefined()
    expect(code).not.toMatch(/from ['"]parseman['"]\s*with/)
  })
})
