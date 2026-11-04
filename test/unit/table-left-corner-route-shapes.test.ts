/**
 * Left-corner routes over the shapes a CSS/Less value grammar takes beyond the
 * plain value ladder (`table-left-corner-routes.test.ts`):
 *
 * - comment trivia, so a `/` after a value may open a comment or the slash
 *   separator;
 * - a lookahead-led sequence under trivia only the caller supplies, which no
 *   route passes;
 * - a function-or-identifier `choice()` whose function arm is pretested by its
 *   opener, so a route through the identifier arm is guarded by that opener;
 * - an identifier-or-function `dispatch()` whose arms re-read the selector's
 *   token through `routed()`, as Less's `IdentifierOrFunction` does;
 * - a `!important` arm that can fail after its corner, so a route's choice
 *   level reports the failure as the choice would.
 *
 * Every reader must give the reference driver's whole `RunResult`.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  choice, dispatch, endsWith, literal, many, node, noTrivia, not, optional, otherwise, regex, routed, rules,
  sepBy, sequence, token, when,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { emitFoldedModule } from '../../src/table/emit.ts'
import { execRules } from '../../src/table/exec.ts'
import { foldPrograms } from '../../src/table/program.ts'
import { routeTable } from '../../src/table/routes.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { readers, seeded } from '../helpers/table-readers.ts'

type Comb = Combinator<unknown>

const one = (children: readonly unknown[]): unknown => children.length === 1 ? children[0] : children
const trivia = regex(/(?:[ \t\n]+|\/\*[^*]*\*\/)+/)

/** CSS-shaped values with comments, a guarded function/identifier choice, and `!important`. */
const guarded = rules({ trivia }, (g: Record<string, Comb>) => ({
  Decl: sequence(regex(/[a-z-]+/), literal(':'), g.List!, optional(g.Important!), literal(';')),
  Important: node('Important', sequence(literal('!'), regex(/important/)), one),
  List: node('List', sepBy(g.Space!, literal(','), { min: 1 }), one),
  Space: node('Space', sequence(g.Slash!, many(g.Slash!)), one),
  Slash: node('Slash', sepBy(g.Value!, literal('/'), { min: 1 }), one),
  Value: node('Value', choice(g.Call!, g.Ident!, regex(/[0-9]+(?:px|em|%)?/)), one),
  Call: node('Call', sequence(regex(/[a-z-]+\(/), optional(g.List!), literal(')')), one),
  // Not a function's opener: the identifier arm carries no pretest of its own.
  Ident: node('Ident', sequence(not(regex(/[a-z-]+\(/)), regex(/[a-z-]+/)), one),
}))

/** The same values, with the function/identifier split made by a `dispatch()` on the opener. */
const dispatched = rules({ trivia }, (g: Record<string, Comb>) => ({
  Decl: sequence(regex(/[a-z-]+/), literal(':'), g.List!, optional(g.Important!), literal(';')),
  Important: node('Important', sequence(literal('!'), regex(/important/)), one),
  List: node('List', sepBy(g.Space!, literal(','), { min: 1 }), one),
  Space: node('Space', sequence(g.Slash!, many(g.Slash!)), one),
  Slash: node('Slash', sepBy(g.Value!, literal('/'), { min: 1 }), one),
  Value: node('Value', choice(g.Word!, regex(/[0-9]+(?:px|em|%)?/)), one),
  Word: dispatch(
    token(noTrivia(sequence(regex(/[a-z-]+/), optional(literal('('))))),
    when(endsWith('('), g.Call!),
    otherwise(g.Ident!),
  ),
  Call: node('Call', sequence(routed(), optional(g.List!), literal(')')), one),
  Ident: node('Ident', routed(), one),
}))

function inputs(): string[] {
  const rnd = seeded(29)
  const sp = (): string => [' ', '', '', '  ', '/**/', ' /* c */ '][rnd(6)]!
  const val = (d: number): string => {
    const r = rnd(d > 1 ? 2 : 3)
    if (r === 0) return String(rnd(30)) + ['', 'px', 'em', '%'][rnd(4)]!
    if (r === 1) return ['a', 'red', 'sans-serif', 'x'][rnd(4)]!
    return `${['f', 'rgb', 'var'][rnd(3)]!}(${list(d + 1)})`
  }
  const slash = (d: number): string => {
    let s = val(d)
    for (let i = rnd(3); i > 0; i--) s += `${sp()}/${sp()}${val(d)}`
    return s
  }
  const space = (d: number): string => Array.from({ length: 1 + rnd(3) }, () => slash(d)).join([' ', '/**/', ' /* c */ '][rnd(3)])
  const list = (d: number): string => Array.from({ length: 1 + rnd(3) }, () => space(d)).join([',', ', ', ' , '][rnd(3)])
  const out = [
    'font:12px/1.5 a, b;', 'font:12px/* c */1.5 a;', 'font:a /* c */ / b;', 'font:a/**/b;', 'font:f(a) b;',
    'font:f (a);', 'font:a !important;', 'font:a !imp;', 'font:a!;', 'font:rgb(1, 2/3);', 'font:a /;', 'font:f(;',
  ]
  for (let i = 0; i < 300; i++) {
    const ok = `font:${sp()}${list(0)}${rnd(4) === 0 ? ' !important' : ''}${sp()};`
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), ok.slice(0, at) + '!' + ok.slice(at), ok.slice(0, at) + ok.slice(at + 1), ok.slice(0, at) + ')' + ok.slice(at)][rnd(4)]!)
  }
  return [...new Set(out)]
}

describe('left-corner route shapes', () => {
  it('stores guards on a pretested arm, and dispatch atoms', () => {
    const shapes = { guards: 0, dispatch: 0 }
    for (const grammar of [guarded, dispatched]) {
      const prog = encodeTable(grammar)
      const routes = routeTable(prog.routes!)
      for (let ip = 0; ip < prog.code.length; ip++) {
        if (!routes.hasTop(ip)) continue
        for (const R of routes.routesAt(ip) ?? []) {
          if (R === undefined) continue
          shapes.guards += R.guards.length
          if (R.atom.kind === 'dispatch') shapes.dispatch++
        }
      }
    }
    expect(shapes.guards).toBeGreaterThan(0)
    expect(shapes.dispatch).toBeGreaterThan(0)
  })

  // A program with no trivia of its own, called with trivia: the lookahead runs
  // before trivia only the caller knows, and the path's segment can start with
  // the comment's `/`, so no route passes the lookahead.
  it('routes no character past a lookahead under trivia a caller supplies', () => {
    const t = regex(/(?:[ \t]+|\/\*[^*]*\*\/)+/)
    const paths = rules((g: Record<string, Comb>) => ({
      Doc: node('Doc', sequence(not(literal('!')), g.Path!, optional(g.Flag!)), one),
      Path: node('Path', sequence(g.Segment!, many(g.Segment!)), one),
      Segment: node('Segment', regex(/\/?[a-z.]+/), one),
      Flag: node('Flag', literal('!'), one),
    }))
    const prog = encodeTable(paths, { hostMode: 'ast' })
    const routed = tableRules({ ...prog, asm: [] }).Doc!
    const reference = execRules(prog).Doc!
    for (const input of ['/*c*/a/b', ' a/b !', '/a/b', 'a/b/*c*/!', '!a']) {
      const got = routed(input, 0, { trivia: t, trackLines: false })
      const want = reference(input, 0, { trivia: t, trackLines: false })
      expect(digestValue(got), input).toBe(digestValue(want))
    }
  })

  for (const [name, grammar] of [['guarded choice', guarded], ['dispatch', dispatched]] as const) {
    it(`parses and fails as the reference driver does in every reader (${name})`, () => {
      const cases = inputs()
      const [first, ...others] = readers(encodeTable(grammar))
      const want = cases.map(input => digestValue(run(first![1].Decl!, input)))
      for (const [reader, entries] of others) {
        cases.forEach((input, i) => {
          expect(digestValue(run(entries.Decl!, input)), `${reader} ${JSON.stringify(input)}`).toBe(want[i])
        })
      }
    }, 60_000)

    it(`round-trips its routes through a printed folded module (${name})`, async () => {
      const prog = encodeTable(grammar)
      const folded = foldPrograms({ ast: prog }, 'ast')
      const src = emitFoldedModule(folded, {
        runtime: pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/table/fold.ts')).href,
        fnSources: folded.base.fns.map(f => String(f)),
        names: { ast: 'gAst' },
      })
      const dir = mkdtempSync(path.join(tmpdir(), 'pm-route-shapes-'))
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
      writeFileSync(path.join(dir, 'grammar.ts'), src)
      const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(dir, 'grammar.ts')).href) as Record<string, Record<string, Comb>>
      const reference = execRules(prog).Decl!
      for (const input of inputs().slice(0, 150)) {
        expect(digestValue(run(mod.gAst!.Decl!, input)), JSON.stringify(input)).toBe(digestValue(run(reference, input)))
      }
    }, 60_000)
  }
})
