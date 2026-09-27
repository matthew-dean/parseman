/**
 * A SELECTIVE build-time assembly — emitted bodies for some sites, the closure
 * engine for the rest — must parse exactly as the closure engine alone does.
 *
 * The two engines each keep their own installed-trivia-scanner slot, so every
 * boundary crossing hands it across (`_px<ip>` in `emit-assembly.ts`, `HYBRID`
 * in `assemble.ts`). These subsets put boundaries everywhere, including inside
 * the css example's nested `parser({ trivia })` scopes, and compare the whole
 * run result: value, spans, `ok`, consumption and expected sets.
 */
import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { AssemblyCache, cfgKey, tableRules } from '../../src/table/assemble.ts'
import { defaultAssemblyCfgs, scanRootIps } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { selectHotSites } from '../../src/table/select-hot.ts'
import { run } from '../../src/functional/run.ts'
import { cssRules } from '../../examples/css/parser.ts'
import { jsonRules, jsonWs } from '../../bench/table-grammars.ts'
import type { Combinator } from '../../src/types.ts'
import { choice, literal, many, noTrivia, parser, regex, rules, sequence, trivia } from '../../src/index.ts'

/**
 * `Words` runs under two DIFFERENT trivia scopes and inside `noTrivia`, so its
 * sites cannot know their scanner statically: they read the INSTALLED one
 * (`_skipTrivia`) — the slot a selective assembly hands across each engine
 * boundary. Scopes nest recursively, so a stale
 * scanner from an outer scope in the other engine would be read. Jess css has
 * 162 such reads; a single-trivia grammar has none.
 */
// Both are character-class runs, so both get a FAST installed scanner
// (`fastTriviaScanner`); a trivia with none leaves the slot null and every read
// falls back to `ctx.trivia`, which cannot go stale.
const space = trivia(regex(/[ ]*/))
const under = trivia(regex(/[ _]*/))
const sharedScopes = rules<Record<string, Combinator<unknown>>>({ trivia: space }, g => ({
  Doc: many(g.Item!),
  Item: choice(g.Loose!, g.Under!, g.Tight!, g.Words!),
  Loose: sequence(literal('('), many(g.Item!), literal(')')),
  Under: parser({ trivia: under }, sequence(literal('<'), many(g.Item!), literal('>'))),
  Tight: noTrivia(sequence(literal('['), many(g.Item!), literal(']'))),
  Words: sequence(g.W!, many(sequence(literal(','), g.W!))),
  W: regex(/[a-z]+/),
}))

type RuleMap = Record<string, Combinator<unknown>>

/** The shipped runtime path for a factory a build printed: `prog.asm`. */
function selective(prog: TableProgram, select: ReadonlySet<number>): TableProgram {
  const cfg = defaultAssemblyCfgs(prog)[0]!
  const em = emitAssemblySource(resolveTable(prog), prog, cfg, scanRootIps(prog), true, select)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
  return { ...prog, asm: [{ key: cfgKey(cfg), factory, plan: em.plan, reached: [...em.reached] }] }
}

/**
 * Deterministic subsets of the emitted sites: halves, stripes, LCG draws and,
 * for a small grammar, every single site and every leave-one-out — the only
 * way to be sure a boundary lands between a scope and the body it installs for.
 */
function subsets(sites: readonly number[], exhaustive: boolean): Array<[string, Set<number>]> {
  const out: Array<[string, Set<number>]> = [
    ['every other', new Set(sites.filter((_, i) => i % 2 === 0))],
    ['the rest', new Set(sites.filter((_, i) => i % 2 === 1))],
    ['every third', new Set(sites.filter((_, i) => i % 3 === 0))],
  ]
  for (const seed of [1, 7, 42, 99]) {
    let x = seed
    out.push([`draw ${seed}`, new Set(sites.filter(() => {
      x = (x * 1103515245 + 12345) % 2147483648
      return x % 4 !== 0
    }))])
  }
  if (exhaustive) {
    for (const ip of sites) {
      out.push([`only ${ip}`, new Set([ip])])
      out.push([`all but ${ip}`, new Set(sites.filter(other => other !== ip))])
    }
  }
  return out
}

/**
 * Every PAIR of sites, as the only two emitted and as the only two left to
 * closures. A stale scanner needs two scopes on one side of the boundary — an
 * outer one that installed a different scanner and the rule scope that would
 * have re-installed the right one — so single-site subsets cannot reach it.
 */
function pairs(sites: readonly number[]): Array<[string, Set<number>]> {
  const out: Array<[string, Set<number>]> = []
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!, b = sites[j]!
      out.push([`only ${a},${b}`, new Set([a, b])])
      out.push([`all but ${a},${b}`, new Set(sites.filter(ip => ip !== a && ip !== b))])
    }
  }
  return out
}

/**
 * The same shape with NO ambient rule trivia: only `Doc` and `Under` install a
 * scanner, so no rule entry re-installs one on the way down and a stale slot is
 * one engine boundary away — `Under` in one engine, `Words` in the other.
 */
const bareScopes = rules<Record<string, Combinator<unknown>>>(g => ({
  Doc: parser({ trivia: space }, many(g.Item!)),
  Item: choice(g.Loose!, g.Under!, g.Tight!, g.Words!),
  Loose: sequence(literal('('), many(g.Item!), literal(')')),
  Under: parser({ trivia: under }, sequence(literal('<'), many(g.Item!), literal('>'))),
  Tight: noTrivia(sequence(literal('['), many(g.Item!), literal(']'))),
  Words: sequence(g.W!, many(sequence(literal(','), g.W!))),
  W: regex(/[a-z]+/),
}))

const SCOPE_INPUTS = [
  '( a , < b _,_ c ( d , e ) _ > [f,g] )', '< a ( b , c ) _,_ d >', '[a,<b _,c>,(d , e)]',
  '( a < b [c,d] _ > e )', '< ( a ,_b) >', '( a ,_b)', '[a , b]', '<_a ,b_ [c]>',
  '< a _,_ b >', '< a , b >', '< ( a , b ) >', '< a _ >', '( a _ )',
]

const CASES: ReadonlyArray<{
  name: string
  map: RuleMap
  entry: string
  inputs: readonly string[]
  trivia?: Combinator<unknown>
  exhaustive?: boolean
}> = [
  {
    name: 'css', map: cssRules as unknown as RuleMap, entry: 'Stylesheet',
    inputs: [
      'a, b .c > d { color: red; margin: 0 auto } @media screen { x { y: z } }',
      '/* c */ a:hover::before{content:"x";width:calc(1px + 2%)} b{}',
      'a { color: ; }',
      'a { b',
    ],
  },
  {
    name: 'shared scopes', map: sharedScopes as unknown as RuleMap, entry: 'Doc', trivia: space, exhaustive: true,
    inputs: SCOPE_INPUTS,
  },
  {
    name: 'bare scopes', map: bareScopes as unknown as RuleMap, entry: 'Doc', exhaustive: true,
    inputs: SCOPE_INPUTS,
  },
  {
    name: 'json', map: jsonRules as unknown as RuleMap, entry: 'Value', trivia: jsonWs,
    inputs: ['{"a":{"b":[1,-2.5,1e10,true,false,null,"x"]},"c":[]}', '[1, 2,', '{"a" 1}'],
  },
]

describe('a selective assembly parses exactly as the closure engine', () => {
  for (const c of CASES) {
    const prog = encodeTable(c.map, {})
    const closure = tableRules({ ...prog, asm: [] })[c.entry]!
    const cfg = defaultAssemblyCfgs(prog)[0]!
    const sites = [...emitAssemblySource(resolveTable(prog), prog, cfg, scanRootIps(prog), true).siteBytes.keys()]
    const opts = c.trivia === undefined ? {} : { trivia: c.trivia as never }

    for (const [label, select] of subsets(sites, c.exhaustive === true)) {
      it(`${c.name}: ${label} (${select.size}/${sites.length} sites emitted)`, () => {
        const hybrid = selective(prog, select)
        // WHICH ENGINE RAN: the hybrid factory, not a silent closure fallback.
        expect(new AssemblyCache(hybrid).for(cfg).emitRefusal).toBeUndefined()
        const entry = tableRules(hybrid)[c.entry]!
        for (const input of c.inputs) {
          expect(run(entry as never, input, opts), input).toEqual(run(closure as never, input, opts))
        }
      })
    }
    if (c.exhaustive === true) {
      it(`${c.name}: every pair of sites on either side of the boundary`, () => {
        const want = c.inputs.map(input => run(closure as never, input, opts))
        for (const [label, select] of pairs(sites)) {
          const entry = tableRules(selective(prog, select))[c.entry]!
          c.inputs.forEach((input, i) => {
            expect(run(entry as never, input, opts), `${label}: ${input}`).toEqual(want[i])
          })
        }
      }, 60_000)
    }
  }

  it('selectHotSites spends at most its budget, and nothing at zero', () => {
    const prog = encodeTable(cssRules as unknown as RuleMap, {})
    const cfg = defaultAssemblyCfgs(prog)[0]!
    const { siteBytes } = emitAssemblySource(resolveTable(prog), prog, cfg, scanRootIps(prog), true)
    const entries = Object.values(prog.rules)
    expect(selectHotSites(prog.code, entries, siteBytes, 0).size).toBe(0)
    const total = [...siteBytes.values()].reduce((a, b) => a + b, 0)
    for (const budget of [total / 4, total / 2, total]) {
      const picked = selectHotSites(prog.code, entries, siteBytes, budget)
      const spent = [...picked].reduce((a, ip) => a + siteBytes.get(ip)!, 0)
      expect(spent).toBeLessThanOrEqual(budget)
      expect(picked.size).toBeGreaterThan(0)
    }
    // Deterministic: the same inputs select the same sites.
    expect([...selectHotSites(prog.code, entries, siteBytes, total / 2)])
      .toEqual([...selectHotSites(prog.code, entries, siteBytes, total / 2)])
  })
})
