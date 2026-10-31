/**
 * An optional repeat item that opens with a gap reads the gap once (`gap-gate.ts`).
 *
 * The shape is SCSS's value chain: every level is `A (op A)*` with `op` spelled
 * `sequence(pad, '*', pad)`, `pad` a regex that may match empty. The repeat
 * scans the pad, ends where the character after it opens no operator, and
 * otherwise hands the pad's end to the pad's regex row. One sum operator arm
 * opens with a DIFFERENT gap regex (`sp`, the `and` level's own gap), so a slot
 * read by the wrong row at the same position shows.
 *
 * Every reader — reference `execRules`, closure and precompiled emitted
 * `tableRules` — must give the interpreter's whole RunResult over generated
 * expressions, in an AST parse, under a CST host, under tolerant recovery, and
 * with line tracking.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, classifiedTrivia, cstBuildHost, keywords, leaf, literal, many, node, noTrivia, optional, regex, rules, sepBy, sequence,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_GAPGATE, OP_NODE } from '../../src/table/ops.ts'

type Comb = Combinator<unknown>

function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
  const resolved = resolveTable(prog)
  const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    return {
      key: cfgKey(cfg),
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory'],
      plan: out.plan, reached: [...out.reached],
    }
  })
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', tableRules({ ...prog, asm: precompiled })],
  ]
}

const pad = regex(/[ \t]*(?:\/\*[^*]*\*\/[ \t]*)*/)
const sp = regex(/[ ]+/)
const fold = (children: readonly unknown[]): unknown => children.length === 1 ? children[0] : { op: children }
const grammar = (mode: 'ast' | 'cst' | 'lines'): Record<string, Comb> => rules({ trivia: regex(/[ \t]+/), ...(mode === 'lines' ? { trackLines: true } : mode === 'cst' ? { hostMode: 'cst' } : {}) }, (g: Record<string, Comb>) => ({
  Decl: sequence(regex(/[a-z]+/), literal(':'), g.List!, literal(';')),
  List: sepBy(g.Space!, sequence(literal(','), optional(regex(/[ \t]+/))), { min: 1 }),
  Space: node('Space', many(g.Or!, { min: 1 }), fold),
  Or: node('Or', noTrivia(sequence(g.Sum!, many(sequence(sp, literal('and'), sp, g.Sum!)))), fold),
  Sum: node('Sum', noTrivia(sequence(g.Product!, many(sequence(g.SumOp!, g.Product!)))), fold),
  SumOp: node('SumOp', choice(
    noTrivia(sequence(pad, literal('+'), pad)),
    noTrivia(sequence(sp, literal('-'), sp)),
    noTrivia(sequence(regex(/[-+]/), pad)),
  ), children => children.join('')),
  Product: node('Product', noTrivia(sequence(g.Unary!, many(sequence(g.ProductOp!, g.Unary!)))), fold),
  ProductOp: node('ProductOp', noTrivia(sequence(pad, regex(/[*%/]/), pad)), children => children.join('')),
  Unary: node('Unary', choice(noTrivia(sequence(literal('-'), g.Atom!)), g.Atom!), fold),
  Atom: choice(regex(/[0-9]+/), regex(/[a-z]+/), sequence(literal('('), g.Or!, literal(')'))),
})) as Record<string, Comb>

// The Less spelling: the operator's padding is the grammar's own trivia,
// `optional(mathTrivia)`, inside a `leaf` that reads both the padding and the
// operator, so the gap's value is observable.
const mathTrivia = classifiedTrivia({ whitespace: regex(/[ \t]+/), blockComment: regex(/\/\*[^*]*\*\//) })
const lessGrammar = (mode: 'ast' | 'cst' | 'lines'): Record<string, Comb> => rules({ trivia: regex(/[ \t]+/), ...(mode === 'lines' ? { trackLines: true } : mode === 'cst' ? { hostMode: 'cst' } : {}) }, (g: Record<string, Comb>) => ({
  Decl: sequence(regex(/[a-z]+/), literal(':'), g.List!, literal(';')),
  List: sepBy(g.Space!, sequence(literal(','), optional(regex(/[ \t]+/))), { min: 1 }),
  Space: node('Space', many(g.Sum!, { min: 1 }), fold),
  Sum: node('Sum', noTrivia(sequence(g.Atom!, many(sequence(
    leaf(noTrivia(sequence(optional(mathTrivia), keywords(['*', '/', '+']), optional(mathTrivia))), v => JSON.stringify(v)),
    g.Atom!,
  )))), fold),
  Atom: choice(regex(/[0-9]+/), regex(/[a-z]+/), sequence(literal('('), g.Sum!, literal(')'))),
})) as Record<string, Comb>

function inputs(): string[] {
  let seed = 23
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const gap = (): string => ['', ' ', '  ', '\t', ' \t', '/*c*/', ' /*c*/ '][rnd(7)]!
  const atom = (d: number): string => {
    const r = rnd(d > 2 ? 3 : 4)
    return r === 0 ? String(rnd(100)) : r === 1 ? ['a', 'red'][rnd(2)]! : r === 2 ? `-${String(rnd(9))}` : `(${atom(d + 1)}${gap()}*${gap()}${atom(d + 1)})`
  }
  const product = (d: number): string => {
    let s = atom(d)
    for (let i = rnd(3); i > 0; i--) s += `${gap()}${['*', '%', '/'][rnd(3)]}${gap()}${atom(d)}`
    return s
  }
  const sum = (d: number): string => {
    let s = product(d)
    for (let i = rnd(3); i > 0; i--) s += [() => `${gap()}+${gap()}`, () => ' - ', () => ' -', () => '+'][rnd(4)]!() + product(d)
    return s
  }
  const or = (): string => (rnd(4) === 0 ? `${sum(0)} and ${sum(0)}` : sum(0))
  const space = (): string => Array.from({ length: 1 + rnd(3) }, or).join(' ')
  // The first leaves the `and` gap's slot at offset 3 with end 5; the second
  // reaches that gap's row at offset 3 through a sum arm, where its end is 4.
  const out = ['x:a  and b;', 'x:1 \t- 2;', 'x:1 2;', 'x:1 * 2;', 'x:1 % 2;', 'x:1 \t- 2;', 'x:1 \t+ 2;', 'x:1 - 2;', 'x:1 -2;', 'x:1-2;', 'x:1 /*c*/ * 2;',
    'x:a and b;', 'x:a  and b;', 'x:1 *;', 'x:1 +;', 'x:(1;', 'x:1 2, 3;', 'x:1\t\t%\t2;']
  for (let i = 0; i < 220; i++) {
    const ok = `x:${Array.from({ length: 1 + rnd(3) }, space).join(', ')};`
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), `${ok.slice(0, at)}?${ok.slice(at)}`, ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return out
}

describe('an optional repeat item that opens with a gap', () => {
  it('gates the operator repeats and does not enter an operator at a gap that opens none', () => {
    const g = grammar('ast')
    const prog = encodeTable(g)
    const gates = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_GAPGATE)
    expect(gates.length).toBe(3)
    let op = prog.rules.ProductOp!
    for (let n = 0; n < 6 && prog.code[op] !== OP_NODE; n++) op = prog.code[op + 2]!
    expect(prog.code[op]).toBe(OP_NODE)
    const counts = countSiteVisits(prog, rs => { run(rs.Decl!, 'x:1 2 3;') })
    expect(counts[op]).toBe(0)
    const withOps = countSiteVisits(prog, rs => { run(rs.Decl!, 'x:1 * 2;') })
    expect(withOps[op]).toBe(1)
  })

  it('gates a repeat whose operator pads with optional(<classified trivia>) inside a leaf', () => {
    const prog = encodeTable(lessGrammar('ast'))
    expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_GAPGATE)).toHaveLength(1)
  })

  for (const [label, mode, opts] of [
    ['ast', 'ast', {}],
    ['cst host', 'cst', { build: cstBuildHost({ tags: true }) }],
    ['tolerant', 'ast', { tolerant: true }],
    ['line tracking', 'lines', {}],
  ] as const) {
    it(`a composite gap parses and fails as the ungated leg does in every reader (${label})`, () => {
      const g = lessGrammar(mode)
      const cases = inputs().map(input => input.replace(/%/g, '/').replace(/ - /g, ' + ').replace(/ and /g, ' '))
      const prog = encodeTable(g)
      // Tolerant recovery is compared with the reference driver too: on this
      // grammar it already differs from the interpreter on `x:(1;` without
      // any gap gate (the reference driver runs every item as written).
      const oracle = mode === 'lines' || label === 'tolerant' ? execRules(prog).Decl! : g.Decl!
      const want = cases.map(input => digestValue(run(oracle, input, opts)))
      for (const [name, entries] of readers(prog)) {
        cases.forEach((input, i) => {
          expect(digestValue(run(entries.Decl!, input, opts)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
        })
      }
    }, 60_000)
  }

  // Line tracking is compared with the reference driver, which runs a gated
  // item as written: the interpreter and the tables already disagree on this
  // grammar's line-tracked results without any gap gate (0.58.0 included).
  for (const [label, mode, opts] of [
    ['ast', 'ast', {}],
    ['cst host', 'cst', { build: cstBuildHost({ tags: true }) }],
    ['tolerant', 'ast', { tolerant: true }],
    ['line tracking', 'lines', {}],
  ] as const) {
    it(`parses and fails as the ungated leg does in every reader (${label})`, () => {
      const g = grammar(mode)
      const cases = inputs()
      const prog = encodeTable(g)
      const oracle = mode === 'lines' ? execRules(prog).Decl! : g.Decl!
      const want = cases.map(input => digestValue(run(oracle, input, opts)))
      for (const [name, entries] of readers(prog)) {
        cases.forEach((input, i) => {
          expect(digestValue(run(entries.Decl!, input, opts)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
        })
      }
    }, 60_000)
  }
})
