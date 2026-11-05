/**
 * `rules((g, prior) => …)`: `prior.X` is the definition of `X` the grammars composed
 * before this one gave it, with a top-level `node()` unwrapped to its body. A dialect
 * uses it to re-reduce an inherited rule, or to extend its choice, without
 * re-spelling the rule.
 *
 * The shapes are the ones the CSS dialects need. Less's `@supports` declaration test
 * parses as CSS's and differs only in its reducer. SCSS adds an interpolation arm to
 * CSS's `SupportsInParens` choice and re-reduces it. In both, the dialect also
 * overrides `Value`, which the inherited body reads through `g.Value`, so open
 * recursion is checked too.
 *
 * Every engine must build the same result: the interpreter (runtime `compose()`), the
 * reference table driver, the closure engine, the printed assembly, and the macro's
 * build-time table for a dialect composed in another module than its base.
 */
import { describe, expect, it } from 'vitest'
import * as P from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { cfgKey, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { EMITTED_PARAMS, emitAssemblySource, type EmittedFactory } from '../../src/table/emit-assembly.ts'
import { assemblyExtraIps, resolveTable, type TableProgram } from '../../src/table/program.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { toEBNF } from '../../src/spec/index.ts'
import { evalMacroExports } from '../helpers/eval-macro-module.ts'
import { macroComposed } from '../helpers/macro-package.ts'

type Comb = Combinator<unknown>

function printed(prog: TableProgram): TableProgram {
  return { ...prog, asm: defaultAssemblyCfgs(prog).map(cfg => {
    const em = emitAssemblySource(resolveTable(prog), prog, cfg, assemblyExtraIps(prog), true)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(...EMITTED_PARAMS, em.source) as EmittedFactory
    return { key: cfgKey(cfg), arity: EMITTED_PARAMS.length, factory, plan: em.plan, reached: [...em.reached] }
  }) }
}

const CSS = `import { rules, node, choice, sequence, literal, regex, trivia } from 'parseman' with { type: 'macro' }
const ws = trivia(regex(/[ \\t\\n]+/))
export const css = rules({ trivia: ws }, g => ({
  SupportsCondition: node('SupportsCondition', sequence(literal('@supports'), g.SupportsInParens), c => c[1]),
  SupportsInParens: node('SupportsInParens', choice(g.SupportsDeclaration, g.SupportsGroup), c => ({ type: 'InParens', test: c[0] })),
  SupportsGroup: node('SupportsGroup', sequence(literal('('), literal('not'), g.SupportsInParens, literal(')')), c => ({ type: 'Not', test: c[2] })),
  SupportsDeclaration: node('SupportsDeclaration', sequence(literal('('), g.Property, literal(':'), g.Value, literal(')')), c => ({ type: 'Declaration', property: c[1], value: c[3] })),
  Property: node('Property', regex(/[a-z-]+/), c => c[0].value),
  Value: node('Value', regex(/[a-z0-9]+/), c => c[0].value),
}))`

const LESS = `import { rules, node, choice, regex, trivia, compose } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
const ws = trivia(regex(/[ \\t\\n]+/))
export const less = compose([css, rules({ trivia: ws }, (g, prior) => ({
  SupportsDeclaration: node('SupportsDeclaration', prior.SupportsDeclaration, c => ({ type: 'Declaration', property: c[1], value: c[3], math: true })),
  Value: node('Value', choice(regex(/@[a-z]+/), regex(/[a-z0-9]+/)), c => c[0].value),
}))])`

const SCSS = `import { rules, node, choice, regex, trivia, compose } from 'parseman' with { type: 'macro' }
import { css } from './base.js'
const ws = trivia(regex(/[ \\t\\n]+/))
export const scss = compose([css, rules({ trivia: ws }, (g, prior) => ({
  SupportsInParens: node('SupportsInParens', choice(prior.SupportsInParens, g.Interpolation), c => ({ type: 'InParens', sass: true, test: c[0] })),
  Interpolation: node('Interpolation', regex(/#\\{[a-z$]+\\}/), c => ({ type: 'Interpolation', text: c[0].value })),
}))])`

type Entry = Comb | P.Runnable

function engines(dialectSource: string, name: string): Record<string, Record<string, Entry>> {
  const base = evalMacroExports(CSS, { ...P })
  const interpreter = evalMacroExports(dialectSource, { ...P, ...base })[name] as Record<string, Comb>
  const prog = encodeTable(interpreter, { hostMode: 'ast' })
  return {
    interpreter,
    reference: execRules(prog),
    closure: tableRules({ ...prog, asm: [] }),
    printed: tableRules(printed(prog)),
    compile: P.compile(interpreter as Record<string, unknown>) as Record<string, P.Runnable>,
    macro: macroComposed(CSS, dialectSource)[name] as Record<string, P.Runnable>,
  }
}

function agree(all: Record<string, Record<string, Entry>>, input: string): P.RunResult {
  const shape = (r: P.RunResult) => ({ ok: r.ok, span: r.span, value: r.ok ? r.value : undefined, expected: r.ok ? [] : [...r.expected].sort() })
  const want = P.run(all.interpreter!.SupportsCondition! as Comb, input)
  for (const [engine, map] of Object.entries(all)) {
    expect(shape(P.run(map.SupportsCondition! as Comb, input)), `${engine} on ${JSON.stringify(input)}`).toEqual(shape(want))
  }
  return want
}

describe('prior: override only the reducer', () => {
  const all = engines(LESS, 'less')

  it("re-reduces the inherited body, which reads the dialect's Value", () => {
    expect(agree(all, '@supports (color: @brand)').value).toEqual({
      type: 'InParens',
      test: { type: 'Declaration', property: 'color', value: '@brand', math: true },
    })
    expect(agree(all, '@supports (not (width: 1))').value).toEqual({
      type: 'InParens',
      test: { type: 'Not', test: { type: 'InParens', test: { type: 'Declaration', property: 'width', value: '1', math: true } } },
    })
  })

  it('fails where the base fails, with the same expected set', () => {
    expect(agree(all, '@supports (color red)').ok).toBe(false)
    expect(agree(all, '@supports (color: )').ok).toBe(false)
  })
})

describe('prior: extend an inherited choice', () => {
  const all = engines(SCSS, 'scss')

  it('keeps every inherited arm and adds the new one, under the new reducer', () => {
    expect(agree(all, '@supports #{$query}').value).toEqual({
      type: 'InParens', sass: true, test: { type: 'Interpolation', text: '#{$query}' },
    })
    expect(agree(all, '@supports (not #{$q})').value).toEqual({
      type: 'InParens',
      sass: true,
      test: { type: 'Not', test: { type: 'InParens', sass: true, test: { type: 'Interpolation', text: '#{$q}' } } },
    })
    expect(agree(all, '@supports (display: grid)').value).toEqual({
      type: 'InParens', sass: true, test: { type: 'Declaration', property: 'display', value: 'grid' },
    })
  })

  it('fails where neither the inherited arms nor the new one match', () => {
    expect(agree(all, '@supports [x]').ok).toBe(false)
  })
})

describe('prior: what it reads and what it costs', () => {
  const base = P.rules(g => ({
    List: P.node('List', P.oneOrMoreSep(g.Item, P.literal(',')), c => ({ items: c.map(x => (x as { value: unknown }).value) })),
    Item: P.regex(/[a-z]+/),
  }))

  it('reads the definition from the grammar composed before, not the winner', () => {
    const first = P.rules((_g, prior: { Item: Comb }) => ({ Item: P.choice(prior.Item, P.regex(/@[a-z]+/)) }))
    const second = P.rules((_g, prior: { Item: Comb }) => ({ Item: P.choice(prior.Item, P.regex(/#[a-z]+/)) }))
    const composed = P.compose([base, first, second])
    expect(P.run(composed.List!, 'a,@b,#c').value).toEqual({ items: ['a', '@b', '#c'] })
  })

  it('adds nothing to the encoded table beside the re-spelled rule', () => {
    const viaPrior = P.compose([base, P.rules((g, prior: { List: Comb }) => ({
      List: P.node('List', prior.List, c => ({ count: c.length })),
    }))])
    const respelled = P.compose([base, P.rules(g => ({
      List: P.node('List', P.oneOrMoreSep(g.Item, P.literal(',')), c => ({ count: c.length })),
    }))])
    const a = encodeTable(viaPrior as Record<string, Comb>, { hostMode: 'ast' })
    const b = encodeTable(respelled as Record<string, Comb>, { hostMode: 'ast' })
    expect([...a.code]).toEqual([...b.code])
    expect(P.run(viaPrior.List!, 'a,b').value).toEqual({ count: 2 })
  })

  it('refuses a prior.X that no earlier grammar defines', () => {
    const dialect = P.rules((_g, prior: { Missing: Comb }) => ({ Entry: P.sequence(prior.Missing, P.literal(';')) }))
    expect(() => P.compose([base, dialect]).Entry)
      .toThrow('compose: prior.Missing is read, but no grammar composed before it defines "Missing"')
  })

  it('fails the build on a prior.X that no earlier grammar defines', () => {
    expect(() => transformMacro(`import { rules, node, regex, compose } from 'parseman' with { type: 'macro' }
export const g = compose([rules(g => ({ Item: regex(/a/) })), rules((g, prior) => ({ List: node('List', prior.List) }))])`, '/pkg/x.ts', new Set(['parseman'])))
      .toThrow('/pkg/x.ts:2 — compose: prior.List is read, but no grammar composed before it defines "List"')
  })

  it('names prior.X on every engine when nothing fills it', () => {
    const named = 'compose: prior.Missing is read, but no grammar composed before it defines "Missing"'
    const unfilled = (): Record<string, Comb> => P.rules((_g, prior: { Missing: Comb }) => ({
      Entry: P.sequence(prior.Missing, P.literal(';')),
    }))
    expect(() => P.parse(unfilled().Entry!, 'a;')).toThrow(named)
    expect(() => P.run(unfilled().Entry!, 'a;')).toThrow(named)
    expect(() => P.run(P.compile(unfilled()).Entry!, 'a;')).toThrow(named)
    const prog = encodeTable(unfilled())
    expect(() => P.run(execRules(prog).Entry!, 'a;')).toThrow(named)
    expect(() => P.run(tableRules({ ...prog, asm: [] }).Entry!, 'a;')).toThrow(named)
    const macro = evalMacroExports(`import { rules, literal, sequence } from 'parseman' with { type: 'macro' }
export const dialect = rules((g, prior) => ({ Entry: sequence(prior.Missing, literal(';')) }))`, { ...P }).dialect as Record<string, P.Runnable>
    expect(() => P.run(macro.Entry!, 'a;')).toThrow(named)
  })

  it('prints an unfilled prior.X by name in the spec', () => {
    const unfilled = P.rules((_g, prior: { Missing: Comb }) => ({ Entry: P.sequence(prior.Missing, P.literal(';')) }))
    expect(toEBNF(unfilled)).toContain('/* prior.Missing */')
  })

  it('types prior from the base grammar', () => {
    const composed = P.compose([base, P.rules((_g, prior: P.PriorRules<typeof base>) => ({
      List: P.node('List', prior.List, c => ({ count: c.length })),
    }))])
    expect(P.run(composed.List!, 'a,b').value).toEqual({ count: 2 })
    // @ts-expect-error a rule the base does not define
    const misspelled = (prior: P.PriorRules<typeof base>) => prior.Lisst
    expect(misspelled).toBeTypeOf('function')
  })

  it('fills prior in a composeLeaf() build', () => {
    const composed = macroComposed(`import { rules, node, regex, literal, oneOrMoreSep } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({
  List: oneOrMoreSep(g.Item, literal(',')),
  Item: regex(/[a-z]+/),
}))`, `import { composeLeaf, rules, node } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
export const dialectLeaf = composeLeaf([base, rules((g, prior) => ({
  List: node('List', prior.List, c => ({ count: c.length })),
}))])`).dialectLeaf as Record<string, P.Runnable>
    expect(P.run(composed.List!, 'a,b,c').value).toEqual({ count: 3 })
  })

  it('accepts a pre-final composeLeaf() piece that reads prior', () => {
    const leaf = transformMacro(`import { rules, node, choice, regex, composeLeaf } from 'parseman' with { type: 'macro' }
const rec = rules(g => ({ V: choice(g.N, g.W), N: regex(/[0-9]+/), W: regex(/[a-z]+/) }))
const d = rules((g, prior) => ({ V: choice(prior.V, regex(/@[a-z]+/)) }))
export const lf = composeLeaf([rec, d, rules(g => ({ T: node('T', g.V, k => ({ v: k[0].value })) }))])`,
    '/pkg/x.ts', new Set(['parseman']))
    const { lf } = evalMacroExports(leaf!.code, { ...P }) as { lf: Record<string, P.Runnable> }
    for (const [input, v] of [['1', '1'], ['a', 'a'], ['@a', '@a']]) {
      expect(P.run(lf.T!, input!).value).toEqual({ v })
    }
    expect(P.run(lf.T!, '%').ok).toBe(false)
  })

  it('types prior from a composed base too', () => {
    const inner = P.rules(() => ({ List: P.regex(/a/) }))
    const base = P.compose([inner, P.rules(() => ({ Extra: P.regex(/b/) }))])
    const composed = P.compose([base, P.rules((_g, prior: P.PriorRules<typeof base>) => ({
      List: P.choice(prior.List, prior.Extra),
    }))])
    expect(P.run(composed.List, 'b').ok).toBe(true)
    // @ts-expect-error a rule the composed base does not define
    const misspelled = (prior: P.PriorRules<typeof base>) => prior.Nope
    expect(misspelled).toBeTypeOf('function')
  })

  it('fails a composeLeaf() build on a prior.X nothing defines', () => {
    expect(() => transformMacro(`import { rules, node, regex, composeLeaf } from 'parseman' with { type: 'macro' }
export const g = composeLeaf([rules(g => ({ Item: regex(/a/) })), rules((g, prior) => ({ List: node('List', prior.List, c => c) }))])`, '/pkg/x.ts', new Set(['parseman'])))
      .toThrow('/pkg/x.ts:2 — composeLeaf: prior.List is read, but no grammar composed before it defines "List"')
  })

  it('carries prior through the IR a built grammar ships', () => {
    // The dialect is built on its own, before anything is composed under it.
    const out = transformMacro(`import { rules, node } from 'parseman' with { type: 'macro' }
export const dialect = rules((g, prior) => ({
  List: node('List', prior.List, c => ({ count: c.length })),
}))`, '/pkg/dialect.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    expect(out.code).toContain('(g, prior) => ({')
    expect(out.code).toContain('prior[\\"List\\"]')

    // …and a downstream build that composes the shipped piece over a base reads it.
    const composed = macroComposed(`import { rules, node, regex, literal, oneOrMoreSep } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({
  List: node('List', oneOrMoreSep(g.Item, literal(',')), c => ({ items: c.length })),
  Item: regex(/[a-z]+/),
}))
export const dialect = rules((g, prior) => ({
  List: node('List', prior.List, c => ({ count: c.length })),
}))`, `import { compose } from 'parseman' with { type: 'macro' }
import { base, dialect } from './base.js'
export const composed = compose([base, dialect])`).composed as Record<string, P.Runnable>
    expect(P.run(composed.List!, 'a,b,c').value).toEqual({ count: 3 })
  })
})
