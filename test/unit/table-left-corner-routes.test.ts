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
import { choice, field, literal, many, node, noTrivia, optional, regex, rules, sepBy, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemblyExtraIps, resolveTable } from '../../src/table/program.ts'
import { routeTable } from '../../src/table/routes.ts'
import { computeSiteLabels } from '../../src/table/site-labels.ts'
import { failCleanAnalysis } from '../../src/table/fail-clean.ts'
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
  it('derives routes for the value ladder, and none for a node with no level to skip', () => {
    const prog = encodeTable(value)
    const t = resolveTable(prog)
    const roots = [...Object.values(prog.rules), ...assemblyExtraIps(prog)]
    const routes = routeTable(t, computeSiteLabels(t.code, roots, false), failCleanAnalysis(t.code))
    const nodes = [...reachableIps(prog)].filter(ip => prog.code[ip] === OP_NODE)
    const tops = nodes.filter(ip => routes.routesAt(ip) !== undefined)
    expect(tops.length).toBeGreaterThan(0)
    expect(tops.length).toBeLessThan(nodes.length)
  })

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
