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
import { AssemblyCache, cfgKey, countSiteVisits, tableRules } from '../../src/table/assemble.ts'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'
import { supercompileRuleMapReplacement } from '../../src/plugin/entry-supercompiler.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { selectHotSites } from '../../src/table/select-hot.ts'
import { run } from '../../src/functional/run.ts'
import { cssRules } from '../../examples/css/parser.ts'
import { jsonRules, jsonWs } from '../../bench/table-grammars.ts'
import type { Combinator } from '../../src/types.ts'
import { choice, literal, many, noTrivia, parser, regex, rules, sequence, trivia } from '../../src/index.ts'
import { seeded } from '../helpers/table-readers.ts'

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
  const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true, select)
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
    const rnd = seeded(seed)
    out.push([`draw ${seed}`, new Set(sites.filter(() => rnd(4) !== 0))])
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
  // An `under` scope that has ENDED, then `_` in the outer scope: only a scanner
  // left stale by a boundary crossing would skip it.
  '< a > ( b ,_c )', '< a >_( b )', '( < a > b ,_c )',
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
    const sites = [...emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true).siteBytes.keys()]
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
    const { siteBytes } = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
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

/** A module long enough (the budget is the module's own length) to pay for an assembly's prelude. */
const PADDING = '// padding\n'.repeat(12000)
const factoryBytes = (code: string): number[] =>
  [...code.matchAll(/factory:function\([^)]*\)\{([\s\S]*?)\n\},plan:/g)].map(m => m[1]!.length)

describe('the macro build ships a selective assembly within its module budget', () => {
  it('the factory it prints, supercompiled, stays within the budget it was given', () => {
    const words = Array.from({ length: 120 }, (_, i) => [`W${i}`, sequence(literal(`w${i}`), regex(/[0-9]*/))] as const)
    const compiled = compileRuleMap([
      ['Doc', many(choice(...words.map(([, w]) => w) as [Combinator<unknown>, ...Combinator<unknown>[]]))],
      ...words,
    ])!
    const full = compiled.selectAssembly(Infinity).bytes
    for (const share of [0.2, 0.4, 0.6, 0.8]) {
      const budget = Math.floor(full * share)
      const { sites, bytes } = compiled.selectAssembly(budget)
      expect(sites.size).toBeGreaterThan(0)
      const printed = supercompileRuleMapReplacement(compiled.prog, compiled.replacementWithMetadata('{}', { select: sites }), sites)
      const [factory] = factoryBytes(printed)
      expect(factory, `budget ${budget}`).toBeLessThanOrEqual(budget)
      expect(factory).toBeLessThanOrEqual(bytes)
    }
  })

  it('never comes back empty from a budget that a smaller budget already filled', () => {
    // The narrowing loop scales its target by ceiling/bytes. Near the ceiling a
    // whole site is the step, so that ratio can stall a few bytes over it; the
    // loop must still land on a fitting selection rather than give up and ship
    // no assembly at all.
    const words = Array.from({ length: 120 }, (_, i) => [`W${i}`, sequence(literal(`w${i}`), regex(/[0-9]*/))] as const)
    const compiled = compileRuleMap([
      ['Doc', many(choice(...words.map(([, w]) => w) as [Combinator<unknown>, ...Combinator<unknown>[]]))],
      ...words,
    ])!
    const full = compiled.selectAssembly(Infinity).bytes
    let filled = false
    for (let share = 0.05; share < 1; share += 0.01) {
      const budget = Math.floor(full * share)
      const { sites, bytes } = compiled.selectAssembly(budget)
      if (filled) expect(sites.size, `budget ${budget}`).toBeGreaterThan(0)
      if (sites.size > 0) { filled = true; expect(bytes).toBeLessThanOrEqual(budget) }
    }
    expect(filled).toBe(true)
  }, 60_000)

  it('a terminal composeLeaf carries generated code for some sites, the closure engine for the rest', () => {
    const source = `import { choice, composeLeaf, literal, many, regex, rules } from 'parseman' with { type: 'macro' }
const recognition = rules(g => ({ A: literal('a'), B: regex(/b ?/), C: regex(/c+/) }))
export const g = composeLeaf([recognition, rules(g => ({ Doc: many(choice(g.A, g.B, g.C)) }))])
${PADDING}`
    const out = transformMacro(source, 'leaf.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    expect(out.code).toMatch(/\bext:\[/)
    const [bytes] = factoryBytes(out.code)
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(source.length)
    const doc = evalMacroModule<Record<string, unknown>>(out.code, 'g').Doc
    const closure = tableRules({ ...encodeTable(rules(g => ({
      A: literal('a'), B: regex(/b ?/), C: regex(/c+/), Doc: many(choice(g.A!, g.B!, g.C!)),
    })) as unknown as RuleMap, {}), asm: [] }).Doc!
    for (const input of ['ab', 'b b a', 'ccx', '']) expect(run(doc as never, input).ok).toBe(run(closure as never, input).ok)
  })

  it('the assemblyBudget option sets the share of the module source a build may spend', () => {
    const source = `import { choice, compose, literal, many, regex, rules } from 'parseman' with { type: 'macro' }
export const g = compose([rules(g => ({ Doc: many(choice(g.A, g.B, g.C)), A: literal('a'), B: regex(/b ?/), C: regex(/c+/) }))])
${PADDING}`
    const at = (budget?: number) => transformMacro(source, 'budget.ts', new Set(['parseman']), false, false, false, undefined, budget)!
    const none = at(0)
    expect(none.warnings).toEqual([])
    expect(factoryBytes(none.code)).toHaveLength(0)
    expect(none.code).toMatch(/tableRules\(\{\s*a:\[\],/)
    const small = factoryBytes(at(0.05).code)[0]!
    const large = factoryBytes(at(1).code)[0]!
    expect(small).toBeLessThanOrEqual(source.length * 0.05)
    expect(large).toBeGreaterThanOrEqual(small)
    expect(factoryBytes(at().code)[0]).toBeLessThanOrEqual(source.length * 0.25)
  })

  it('a compose() result is the parser of a module without a composeLeaf, and a piece of one with', () => {
    const grammar = `rules(g => ({ Doc: many(choice(g.A, g.B)), A: literal('a'), B: regex(/b+/) }))`
    const alone = transformMacro(`import { choice, compose, literal, many, regex, rules } from 'parseman' with { type: 'macro' }
export const g = compose([${grammar}])
${PADDING}`, 'alone.ts', new Set(['parseman']))!
    const beside = transformMacro(`import { choice, compose, composeLeaf, literal, many, regex, rules } from 'parseman' with { type: 'macro' }
const recognition = rules(g => ({ A: literal('a') }))
export const leaf = composeLeaf([recognition, rules(g => ({ Doc: many(g.A) }))])
export const g = compose([${grammar}])
${PADDING}`, 'beside.ts', new Set(['parseman']))!
    expect(alone.warnings).toEqual([])
    expect(beside.warnings).toEqual([])
    expect(factoryBytes(alone.code)).toHaveLength(1)
    // Only the composeLeaf spends the module's budget.
    expect(factoryBytes(beside.code)).toHaveLength(1)
    expect(beside.code).toMatch(/export const g = \/\* @__PURE__ \*\/ tableRules\(\{\s*a:\[\],/)
  })
})

describe('an optional corpus profile ranks sites by measured calls', () => {
  it('countSiteVisits counts the closure engine and constructs no code', () => {
    const prog = encodeTable(cssRules as unknown as RuleMap, {})
    const realFunction = globalThis.Function
    let constructed = 0
    globalThis.Function = new Proxy(realFunction, {
      construct(target, args, nt) { constructed++; return Reflect.construct(target, args, nt) as object },
    })
    let counts: Int32Array
    try {
      counts = countSiteVisits(prog, rules => {
        expect(run(rules.Stylesheet as never, 'a { color: red } b { x: y }').ok).toBe(true)
      })
    } finally { globalThis.Function = realFunction }
    expect(constructed).toBe(0)
    expect(counts!.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  it('a profile selects only sites the corpus ran, and that assembly parses as the closure engine', () => {
    const prog = encodeTable(cssRules as unknown as RuleMap, {})
    const cfg = defaultAssemblyCfgs(prog)[0]!
    const { siteBytes } = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    const counts = countSiteVisits(prog, rules => { run(rules.Stylesheet as never, 'a { color: red }') })
    const total = [...siteBytes.values()].reduce((a, b) => a + b, 0)
    const picked = selectHotSites(prog.code, Object.values(prog.rules), siteBytes, total, counts)
    expect(picked.size).toBeGreaterThan(0)
    for (const ip of picked) expect(counts[ip]).toBeGreaterThan(0)
    const closure = tableRules({ ...prog, asm: [] }).Stylesheet!
    const entry = tableRules(selective(prog, picked)).Stylesheet!
    for (const input of CASES[0]!.inputs) expect(run(entry as never, input)).toEqual(run(closure as never, input))
  })

  it('the assemblyProfile option changes only which sites are generated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parseman-profile-'))
    try {
      const corpus = join(dir, 'corpus.txt')
      writeFileSync(corpus, 'b b b b b b b b b b')
      const source = `import { choice, compose, many, regex, rules, literal } from 'parseman' with { type: 'macro' }
export const g = compose([rules(g => ({ Doc: many(choice(g.A, g.B, g.C)), A: literal('a'), B: regex(/b ?/), C: regex(/c+/) }))])
${PADDING}`
      const plain = transformMacro(source, join(dir, 'g.ts'), new Set(['parseman']))!
      const profile = { entry: 'Doc', files: [corpus] }
      const profiled = transformMacro(source, join(dir, 'g.ts'), new Set(['parseman']), false, false, false, profile)!
      expect(plain.warnings).toEqual([])
      expect(profiled.warnings).toEqual([])
      const sites = (code: string): string => code.match(/function _pf\d+/g)!.sort().join()
      expect(sites(profiled.code)).not.toBe(sites(plain.code))
      // The same profile object, after the corpus changes on disk (a watch build).
      writeFileSync(corpus, 'c c c c c c c c c c')
      utimesSync(corpus, new Date(), new Date(Date.now() + 10_000))
      const edited = transformMacro(source, join(dir, 'g.ts'), new Set(['parseman']), false, false, false, profile)!
      expect(sites(edited.code)).not.toBe(sites(profiled.code))
      const a = evalMacroModule<Record<string, unknown>>(plain.code, 'g').Doc
      const b = evalMacroModule<Record<string, unknown>>(profiled.code, 'g').Doc
      for (const input of ['ab', 'b b a', 'x']) expect(run(b as never, input)).toEqual(run(a as never, input))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
