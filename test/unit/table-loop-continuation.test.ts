/**
 * A loop decides whether it continues on the character in front of it.
 *
 * An operator chain `A (op A)*` whose operator opens with an optional pad
 * (`ws* '*' ws*`) used to have no first set at all, because a regex that may
 * match empty reports `any`: every level's repeat entered its operator at every
 * value end — at `;`, at `)` — opened the operator's node, scanned the empty pad
 * and failed on the next character. A sequence tracks nullability itself, so it
 * now unions the pad's non-empty first characters with the next term's, and the
 * repeat's item gate (and the operator node's own gate) stops the loop there.
 *
 * A separated list is the same loop with a separator: its separator's first set
 * is already in the table, so a list end (`;` after `a, b`) stops without
 * entering the separator.
 *
 * Every reader — reference `execRules`, closure and precompiled emitted
 * `tableRules` — must give the interpreter's whole RunResult, accepting and
 * failing inputs alike, over a generated set of expressions.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, literal, many, node, noTrivia, optional, regex, rules, sepBy, sequence,
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
import { OP_REP, OP_REPV } from '../../src/table/ops.ts'

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

// The SCSS value shape: padded operators, three precedence levels, a word
// operator spelled `ws and ws`, a prefix `-`, a parenthesised group, then a
// space list of those and a comma list of space lists, under ambient trivia.
const pad = regex(/[ \t]*/)
const ws = regex(/[ \t]+/)
const fold = (children: readonly unknown[]): unknown => children.length === 1 ? children[0] : { op: children }
const expr = rules({ trivia: regex(/[ \t]+/) }, (g: Record<string, Comb>) => ({
  Decl: sequence(regex(/[a-z]+/), literal(':'), g.List!, literal(';')),
  List: sepBy(g.Space!, sequence(literal(','), optional(ws)), { min: 1 }),
  Space: node('Space', many(g.Or!, { min: 1 }), fold),
  Or: node('Or', noTrivia(sequence(g.Sum!, many(sequence(ws, literal('and'), ws, g.Sum!)))), fold),
  Sum: node('Sum', noTrivia(sequence(g.Product!, many(sequence(g.SumOp!, g.Product!)))), fold),
  SumOp: node('SumOp', choice(
    noTrivia(sequence(pad, literal('+'), pad)),
    noTrivia(sequence(pad, literal('-'), ws)),
  ), children => children.join('')),
  Product: node('Product', noTrivia(sequence(g.Unary!, many(sequence(g.ProductOp!, g.Unary!)))), fold),
  ProductOp: node('ProductOp', noTrivia(sequence(pad, regex(/[*%/]/), pad)), children => children.join('')),
  Unary: node('Unary', choice(noTrivia(sequence(literal('-'), g.Atom!)), g.Atom!), fold),
  Atom: choice(regex(/[0-9]+/), regex(/[a-z]+/), sequence(literal('('), g.Or!, literal(')'))),
})) as Record<string, Comb>

/** Seeded generator: well-formed expressions, then each with one defect. */
function inputs(): string[] {
  let seed = 7
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const sp = (): string => [' ', '', '', '  ', '\t'][rnd(5)]!
  const atom = (d: number): string => {
    const r = rnd(d > 2 ? 3 : 5)
    if (r === 0) return String(rnd(100))
    if (r === 1) return ['a', 'red', 'x'][rnd(3)]!
    if (r === 2) return `-${String(rnd(9))}`
    return `(${sp()}${or(d + 1)}${sp()})`
  }
  const product = (d: number): string => {
    let s = atom(d)
    for (let i = rnd(3); i > 0; i--) s += `${sp()}${['*', '%', '/'][rnd(3)]}${sp()}${atom(d)}`
    return s
  }
  const sum = (d: number): string => {
    let s = product(d)
    for (let i = rnd(3); i > 0; i--) s += rnd(2) === 0 ? `${sp()}+${sp()}${product(d)}` : ` - ${product(d)}`
    return s
  }
  const or = (d: number): string => (rnd(4) === 0 ? `${sum(d)} and ${sum(d)}` : sum(d))
  const space = (): string => Array.from({ length: 1 + rnd(3) }, () => or(0)).join(' ')
  const list = (): string => Array.from({ length: 1 + rnd(4) }, () => space()).join([',', ', ', ' , ', ' ,'][rnd(4)])
  const out = ['x:1;', 'x:1 2;', 'x:1,2;', 'x:1 ,2;', 'x:a and b;', 'x:1*;', 'x:1 +;', 'x:1, ;', 'x:(1;', 'x:;', 'x:1 - -2;', 'x:1 -2;']
  for (let i = 0; i < 300; i++) {
    const ok = `x:${sp()}${list()}${sp()};`
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), ok.slice(0, at) + '?' + ok.slice(at), ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return out
}

describe('a loop decides on the character in front of it', () => {
  it('an operator led by an optional pad has a finite first set', () => {
    const op = sequence(pad, regex(/[*%]/), pad)
    expect(op._meta.firstSet.kind).toBe('ranges')
    const codes = op._meta.firstSet.kind === 'ranges' ? op._meta.firstSet.ranges : []
    const has = (c: string): boolean => codes.some(r => r.lo <= c.charCodeAt(0) && c.charCodeAt(0) <= r.hi)
    expect(['*', '%', ' ', '\t'].every(has)).toBe(true)
    expect(has(';')).toBe(false)
    // The pad alone still matches empty anywhere.
    expect(pad._meta.firstSet.kind).toBe('any')
  })

  it('gives every operator repeat an item class', () => {
    const prog = encodeTable(expr)
    const repeats = [...reachableIps(prog)].filter(ip => (prog.code[ip] === OP_REP || prog.code[ip] === OP_REPV) && prog.code[ip + 4] === -1 && prog.code[ip + 2] === 0)
    expect(repeats.length).toBeGreaterThanOrEqual(3)
    for (const ip of repeats) expect(prog.code[ip + 7], `repeat @${ip}`).toBeGreaterThanOrEqual(0)
  })

  it('stops a separated list at its end without entering the separator', () => {
    const prog = encodeTable(expr)
    const list = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_REP && prog.code[ip + 4]! >= 0)!
    const sepIp = prog.code[list + 4]!
    const counts = countSiteVisits(prog, rs => { run(rs.Decl!, 'x:1, 2, 3;') })
    // Two separators; the list end at `;` enters none.
    expect(counts[sepIp]).toBe(2)
  })

  it('a separated list whose first item fails reports the item at the list start', () => {
    // `failAt(pos)` in repeat.ts: the item's derived set, not the deeper set the
    // failed item left (`")"` inside the group of `(1;`).
    for (const [name, entries] of readers(encodeTable(expr))) {
      const r = run(entries.Decl!, 'x:(1;')
      expect(r.ok, name).toBe(false)
      expect(r.ok ? undefined : [r.span.start, r.expected], name).toEqual([2, ['"-"', '/[0-9]+/', '/[a-z]+/', '"("']])
    }
  })

  it('parses and fails as the interpreter does in every reader', () => {
    const cases = inputs()
    const want = cases.map(input => digestValue(run(expr.Decl!, input)))
    for (const [name, entries] of readers(encodeTable(expr))) {
      cases.forEach((input, i) => {
        expect(digestValue(run(entries.Decl!, input)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
      })
    }
  }, 60_000)
})
