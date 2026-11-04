/**
 * Left-corner routes (`routes.ts`): a route-top node reads, at entry, the route
 * the character in front of it takes, runs the deepest piece once and completes
 * each level above on its lone child, resuming a level in place where its
 * continuation can start.
 *
 * The closure engine is the only reader with routes. It and the emitted reader
 * must give the reference driver's whole `RunResult` (trees, spans, errors,
 * expected sets)
 * on a value grammar shaped like the CSS and Less value ladders: a slash level
 * whose separator opens with an `optional` gap, a space level, a comma level,
 * and a mandatory gated term after a corner.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { emitFoldedModule } from '../../src/table/emit.ts'
import { execRules } from '../../src/table/exec.ts'
import { choice, field, literal, many, node, noTrivia, optional, regex, rules, sepBy, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { foldPrograms, unfoldVariant } from '../../src/table/program.ts'
import { routeTable } from '../../src/table/routes.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_NODE } from '../../src/table/ops.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { readers, seeded } from '../helpers/table-readers.ts'

type Comb = Combinator<unknown>

const ws = regex(/[ \t]+/)
const one = (children: readonly unknown[]): unknown => children.length === 1 ? children[0] : children
const value = rules({ trivia: regex(/[ \t]+/) }, (g: Record<string, Comb>) => ({
  Decl: sequence(regex(/[a-z]+/), literal(':'), g.List!, literal(';')),
  List: node('List', sepBy(g.Space!, literal(','), { min: 1 }), one),
  Space: node('Space', noTrivia(sequence(g.Term!, many(choice(sequence(field('sep', ws), g.Term!), g.Term!)))), one),
  Term: node('Term', noTrivia(sequence(g.Value!, many(sequence(optional(ws), literal('/'), optional(ws), g.Value!)))), one),
  Value: node('Value', choice(g.Call!, regex(/[0-9]+(?:px)?/), regex(/[a-z]+/), sequence(literal('['), g.List!, literal(']'))), one),
  Call: node('Call', sequence(regex(/[a-z]+\(/), g.List!, literal(')')), one),
}))

function inputs(): string[] {
  const rnd = seeded(11)
  const sp = (): string => [' ', '', '', '  ', '\t'][rnd(5)]!
  const val = (d: number): string => {
    const r = rnd(d > 1 ? 2 : 4)
    if (r === 0) return String(rnd(30)) + (rnd(2) === 0 ? 'px' : '')
    if (r === 1) return ['a', 'red', 'x'][rnd(3)]!
    if (r === 2) return `f(${list(d + 1)})`
    return `[${list(d + 1)}]`
  }
  const term = (d: number): string => {
    let s = val(d)
    for (let i = rnd(3); i > 0; i--) s += `${sp()}/${sp()}${val(d)}`
    return s
  }
  const space = (d: number): string => Array.from({ length: 1 + rnd(3) }, () => term(d)).join(' ')
  const list = (d: number): string => Array.from({ length: 1 + rnd(3) }, () => space(d)).join([',', ', ', ' , '][rnd(3)])
  const out = ['x:12px/1 a, b;', 'x:a;', 'x:a )', 'x:a /)', 'x:a / )', 'x:a b /;', 'x:a,;', 'x:f(a b;', 'x:[a', 'x:a ]', 'x:1/2 3/4,5;', 'x:a  ;']
  for (let i = 0; i < 300; i++) {
    const ok = `x:${sp()}${list(0)}${sp()};`
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), ok.slice(0, at) + '?' + ok.slice(at), ok.slice(0, at) + ok.slice(at + 1), ok.slice(0, at) + ')' + ok.slice(at)][rnd(4)]!)
  }
  return [...new Set(out)]
}

describe('left-corner routes', () => {
  it('stores routes for the value ladder, and none for a node with no level to skip', () => {
    const prog = encodeTable(value)
    const routes = routeTable(prog.routes!)
    const nodes = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_NODE)
    const tops = nodes.filter(ip => routes.hasTop(ip))
    expect(tops.length).toBeGreaterThan(0)
    expect(tops.length).toBeLessThan(nodes.length)
    for (const ip of nodes) expect(routes.routesAt(ip) !== undefined).toBe(routes.hasTop(ip))
  })

  it('stores routes only where an assembly reads them, and a fold keeps each variant\'s own', () => {
    const ast = encodeTable(value)
    const lines = encodeTable(value, { trackLines: true })
    const cst = encodeTable(value, { hostMode: 'cst' })
    expect(lines.routes).toBeUndefined()
    expect(cst.routes).toBeUndefined()
    for (const base of ['ast', 'lines', 'cst']) {
      const folded = foldPrograms({ ast, lines, cst }, base)
      expect(unfoldVariant(folded, 'ast').routes).toEqual(ast.routes)
      expect(unfoldVariant(folded, 'lines').routes).toBeUndefined()
      expect(unfoldVariant(folded, 'cst').routes).toBeUndefined()
    }
  })

  it('round-trips through a printed folded module, and parses there as the reference does', async () => {
    const progs = { ast: encodeTable(value), lines: encodeTable(value, { trackLines: true }) }
    for (const base of ['ast', 'lines']) {
      const folded = foldPrograms(progs, base)
      const src = emitFoldedModule(folded, {
        runtime: pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/table/fold.ts')).href,
        fnSources: folded.base.fns.map(f => String(f)),
        names: { ast: 'gAst', lines: 'gLines' },
      })
      // The routes print once, on the base where it is the AST variant, else on its delta.
      expect(src.split(base === 'ast' ? 'ro:{' : 'o:{').length - 1).toBe(1)
      const dir = mkdtempSync(path.join(tmpdir(), 'pm-routes-fold-'))
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
      writeFileSync(path.join(dir, 'grammar.ts'), src)
      const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(dir, 'grammar.ts')).href) as Record<string, Record<string, Comb>>
      const reference = execRules(progs.ast).Decl!
      // The first parse of an assembly runs unrouted; every later one routes.
      for (const input of inputs().slice(0, 120)) {
        expect(digestValue(run(mod.gAst!.Decl!, input)), `${base} ${JSON.stringify(input)}`).toBe(digestValue(run(reference, input)))
      }
    }
  }, 60_000)

  it('parses and fails as the reference driver does in every reader', () => {
    const cases = inputs()
    expect(cases.length).toBeGreaterThan(400)
    const [first, ...others] = readers(encodeTable(value))
    const reference = first![1]
    const want = cases.map(input => digestValue(run(reference.Decl!, input)))
    for (const [name, entries] of others) {
      cases.forEach((input, i) => {
        expect(digestValue(run(entries.Decl!, input)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
      })
    }
  }, 60_000)
})
