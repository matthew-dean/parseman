/**
 * Targeted coverage for src/plugin/* — the largest uncovered area in the suite.
 * Exercises ref() macro pre-pass, destructure warning paths, module aliases,
 * and direct evaluator entry points not reached by parity tests alone.
 */
import { describe, it, expect, vi } from 'vitest'
import { parseSync } from 'oxc-parser'
import type { Expression, Node } from '@oxc-project/types'
import parsemanPlugin, { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import {
  evaluateRefDeclaration,
  applyDefineStatement,
  evaluateParserFactory,
  evaluateWordFactory,
  evaluateCombinatorArray,
  evaluateExpr,
  referencesAny,
} from '../../src/plugin/evaluator.ts'
import { cstBuildHost, literal, parse, ref, run, sequence, optional } from '../../src/index.ts'

function transform(code: string, aliases = new Set(['parseman'])) {
  return transformMacro(code, 'plugin-coverage.ts', aliases)
}

function parseInit(code: string): Expression {
  const ast = parseSync('eval.ts', code)
  const stmt = ast.program.body[0]!
  if (stmt.type === 'VariableDeclaration') {
    return (stmt.declarations[0] as { init: Expression }).init
  }
  if (stmt.type === 'ExpressionStatement') {
    return (stmt as { expression: Expression }).expression
  }
  throw new Error(`unexpected stmt: ${stmt.type}`)
}

describe('transformMacro — parse failures', () => {
  it('returns null when the source has syntax errors', () => {
    expect(transformMacro('const {{{', 'broken.ts')).toBeNull()
  })
})

describe('transformMacro — ref() cluster', () => {
  const REF_MACRO = `
import { ref, literal, sequence, optional } from 'parseman' with { type: 'macro' }
const item = ref()
item.define(sequence(literal('['), optional(item), literal(']')))
export const brackets = item
`.trim()

  it('compiles a ref()/define() cluster and strips .define() statements', () => {
    const result = transform(REF_MACRO)!
    expect(result.warnings).toEqual([])
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toContain('.define(')
    expect(result.code).toContain('export const brackets =')
  })

  it('matches interpreter output for nested brackets', () => {
    const item = ref<unknown>()
    item.define(sequence(literal('['), optional(item), literal(']')))

    const result = transform(REF_MACRO)!
    type ParseFn = (input: string, pos: number, ctx: { trackLines: boolean }) => ReturnType<typeof parse>
    const compiled = evalMacroModule<ParseFn>(result.code, 'brackets')

    for (const input of ['[]', '[[]]', '[[x]]', '[a[b]]']) {
      const i = parse(item, input)
      const m = compiled(input, 0, { trackLines: false })
      expect(m).toEqual(i)
    }
  })
})

describe('transformMacro — rules() destructure warnings', () => {
  it('warns on rest elements in a rules() destructure', () => {
    const code = `
import { rules, regex, transform } from 'parseman' with { type: 'macro' }
const { A, ...rest } = rules(g => {
  const A = transform(regex(/a/), s => s)
  return { A }
})
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes("rest element"))).toBe(true)
  })

  it('warns when a destructured rule key is missing from the factory', () => {
    const code = `
import { rules, regex, transform } from 'parseman' with { type: 'macro' }
const { Missing } = rules(g => {
  const A = transform(regex(/a/), s => s)
  return { A }
})
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes('"Missing"'))).toBe(true)
  })

  it('warns when rules() has no factory argument', () => {
    const code = `
import { rules } from 'parseman' with { type: 'macro' }
const g = rules()
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes('needs a factory argument'))).toBe(true)
  })

  it('warns when a destructured binding is not from rules()', () => {
    const code = `
import { literal } from 'parseman' with { type: 'macro' }
const { x } = literal('a')
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes('destructured macro binding must come from rules'))).toBe(true)
  })
})

describe('transformMacro — module aliases and early exits', () => {
  it('accepts moduleAliases for re-export specifiers', () => {
    const code = `
import { literal } from '@app/parseman' with { type: 'macro' }
const x = literal('hi')
`.trim()
    const result = transform(code, new Set(['parseman', '@app/parseman']))!
    expect(result.code).not.toContain('@app/parseman')
    expect(result.code).toContain('const x =')
  })

  it('returns null for unparseable source', () => {
    expect(transformMacro('const {{{', 'bad.ts')).toBeNull()
  })

  it('returns null when code lacks parseman or macro markers', () => {
    expect(transformMacro('const x = 1', 't.ts')).toBeNull()
    expect(transformMacro("import { x } from 'other'", 't.ts')).toBeNull()
  })

  it('returns null when the file has parse errors', () => {
    expect(transformMacro('const x: number = "nope"', 'bad.ts')).toBeNull()
  })
})

function vitePlugin() {
  const raw = parsemanPlugin.vite({})
  return (Array.isArray(raw) ? raw[0] : raw)!
}

function pluginTransform(plugin: ReturnType<typeof vitePlugin>) {
  const hook = plugin.transform
  return (typeof hook === 'function' ? hook : hook?.handler) as
    | ((this: { warn?: (msg: string) => void }, code: string, id: string) => unknown)
    | undefined
}

describe('unplugin hook', () => {
  it('runs transform via the vite adapter and surfaces warnings', () => {
    const transform = pluginTransform(vitePlugin())
    const warn = vi.fn()
    const code = `
import { regex } from 'parseman' with { type: 'macro' }
const dynamic = regex(externalPattern)
`.trim()
    const out = transform!.call({ warn }, code, '/proj/dynamic.ts')
    expect(out).not.toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('falls back to console.warn when the host provides no warn hook', () => {
    const transform = pluginTransform(vitePlugin())
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const code = `
import { regex } from 'parseman' with { type: 'macro' }
const dynamic = regex(externalPattern)
`.trim()
    transform!.call({}, code, '/proj/no-warn.ts')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('evaluator — ref()/define() helpers', () => {
  it('evaluateRefDeclaration registers a ref slot in scope', () => {
    const scope = new Map()
    const init = parseInit('const item = ref()')
    const slot = evaluateRefDeclaration(init, 'item', scope)
    expect(slot).not.toBeNull()
    expect(scope.has('item')).toBe(true)
  })

  it('applyDefineStatement wires a combinator into a ref slot', () => {
    const scope = new Map()
    const init = parseInit('const item = ref()')
    evaluateRefDeclaration(init, 'item', scope)
    const defineCode = 'item.define(literal("x"))'
    const defineExpr = parseInit(defineCode)
    expect(applyDefineStatement(defineExpr, scope, defineCode)).toBe(true)
    const entry = scope.get('item')!
    expect(parse(entry.combi, 'x').ok).toBe(true)
  })

  it('applyDefineStatement returns false for non-define calls', () => {
    const scope = new Map()
    expect(applyDefineStatement(parseInit('foo()'), scope, 'foo()')).toBe(false)
  })
})

describe('evaluator — evaluateParserFactory', () => {
  it('evaluates body statements that bind non-combinator values', () => {
    const code = `rules(g => {
  const n = 1
  const A = literal('a')
  return { A }
})`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    expect(map?.has('A')).toBe(true)
    /*
     * THE RULE ITSELF, NOT A `lazy` WRAPPING IT.
     *
     * `evaluateParserFactory` used to pre-mint a `ref()` for every declared key and
     * hand those back whether or not the factory referenced them, because it was a
     * second implementation of `rules()`. It calls the real `rules()` now, and
     * `rules()` only keeps a placeholder for a key something actually touched
     * through `g` — an untouched key is stored directly (`parser.ts:170-190`).
     *
     * So this assertion was encoding the copy's shape, not a contract. The runtime
     * shape is the one the encoder is measured good on, and converging on it is what
     * removed a spurious `lazy` hop from every macro-lowered rule: 4 size fixtures
     * dropped below their committed ceiling, and the macro's coverage ids stopped
     * carrying a `lazy:0` segment the runtime route never had.
     */
    expect(map?.get('A')?._def.tag).toBe('literal')
  })

  it('returns null when the factory body has unsupported statements', () => {
    const code = `rules(g => {
  foo()
  return { A: literal('a') }
})`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    expect(evaluateParserFactory(factory, new Map(), code, [])).toBeNull()
  })
})

describe('evaluator — evaluateWordFactory / arrays / expr', () => {
  it('evaluateWordFactory reads an optional boundary literal', () => {
    const init = parseInit("makeWord('A-Za-z')")
    expect(evaluateWordFactory(init, new Map())?.boundary).toBe('A-Za-z')
  })

  it('evaluateCombinatorArray resolves a literal array of combinators', () => {
    const init = parseInit('[literal("a"), literal("b")]')
    expect(evaluateCombinatorArray(init, new Map())?.map(p => p._tag)).toEqual(['literal', 'literal'])
  })

  it('evaluateCombinatorArray rejects empty and non-combinator arrays', () => {
    expect(evaluateCombinatorArray(parseInit('[]'), new Map())).toBeNull()
    expect(evaluateCombinatorArray(parseInit('[1, 2]'), new Map())).toBeNull()
  })

  it('evaluateExpr resolves rules() g.member references inside a factory', () => {
    const code = `rules(g => {
  const leaf = literal('x')
  const wrap = sequence(g.leaf, g.leaf)
  return { leaf, wrap }
})`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    expect(map?.has('wrap')).toBe(true)
  })
})

describe('transformMacro — inline failure warnings', () => {
  it('warns when a ref() is never defined', () => {
    const code = `
import { ref } from 'parseman' with { type: 'macro' }
const item = ref()
const p = item
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes('ref()') && w.includes("couldn't be inlined"))).toBe(true)
  })
})

describe('transformMacro — additional combinator forms', () => {
  it('compiles not(), balanced(), and scanTo() in one macro file', () => {
    const code = `
import { not, literal, balanced, scanTo, transform, regex } from 'parseman' with { type: 'macro' }
const num = transform(sequence(regex(/[0-9]+/), not(regex(/[a-z]/))), ([n]) => n)
const body = transform(scanTo(literal(')'), { skip: [balanced('(', ')')] }), s => s)
`.trim()
    const result = transform(code)!
    expect(result.warnings).toEqual([])
    expect(result.code).not.toContain("from 'parseman'")
    expect(result.code).not.toMatch(/(^|[\s(,=])not\(/m)
    expect(result.code).not.toContain('scanTo(')
  })

  it('compiles makeWord() factory and chained calls', () => {
    const code = `
import { makeWord } from 'parseman' with { type: 'macro' }
const kw = makeWord('A-Za-z_')
const ifKw = kw('if')
`.trim()
    const result = transform(code)!
    expect(result.warnings).toEqual([])
    expect(result.code).toContain('const ifKw =')
  })
})

describe('transformMacro — static node option shapes', () => {
  it('resolves node tags through same-file static constants, aliases, shorthand, and TS wrappers', () => {
    const code = `
import { rules, node, regex } from 'parseman' with { type: 'macro' }
const baseTags = ['AtRule', 'Statement'] as const
const tags = baseTags
export const grammar = rules(g => ({
  AtRule: node('AtRule', regex(/@[a-z]+/), ({ tags: ['DirectAtRule'] as const, debugName: 'ignored' })),
  Declaration: node('Declaration', regex(/[a-z]+/), { tags: baseTags, extra: true }),
}))
`.trim()
    const result = transform(code)!

    expect(result.warnings).toEqual([])
    expect(result.code).toContain("Symbol.for('parseman.grammarReflection')")
    expect(result.code).toContain('"tags":["DirectAtRule"]')
    expect(result.code).toContain('"tags":["AtRule","Statement"]')
  })

  it('treats same-file static node options identifiers as options, not build callbacks', () => {
    const code = `
import { rules, node, regex } from 'parseman' with { type: 'macro' }
const tags = ['AtRule'] as const
const opts = { tags }
export const grammar = rules(g => ({
  AtRule: node('AtRule', regex(/@[a-z]+/), opts),
}))
`.trim()
    const result = transform(code)!

    expect(result.warnings).toEqual([])
    expect(result.code).toContain('"tags":["AtRule"]')

    const grammar = evalMacroModule<{ AtRule: (input: string, pos: number, ctx: { trackLines: boolean; build: typeof cstBuildHost }) => unknown }>(result.code.replace(/\s+as const\b/g, ''), 'grammar')
    expect(() => grammar.AtRule('@media', 0, { trackLines: false, build: cstBuildHost })).not.toThrow()
  })

  it('treats scoped undefined/null build placeholders as absent build callbacks', () => {
    const code = `node('T', literal('a'), noBuild, { tags: ['x'] })`
    const undef = evaluateExpr(parseInit(code), new Map([['noBuild', undefined]]) as never, code)
    const nulled = evaluateExpr(parseInit(code), new Map([['noBuild', null]]) as never, code)

    expect(undef?._def.tag).toBe('node')
    expect(nulled?._def.tag).toBe('node')
    if (undef?._def.tag === 'node' && nulled?._def.tag === 'node') {
      expect(undef._def.build).toBeUndefined()
      expect(undef._def.buildSrc).toBeUndefined()
      expect(undef._def.tags).toEqual(['x'])
      expect(nulled._def.build).toBeUndefined()
      expect(nulled._def.buildSrc).toBeUndefined()
      expect(nulled._def.tags).toEqual(['x'])
    }
  })

  it('macro-lowers scoped undefined build placeholders as structural tagged nodes', () => {
    const code = `
import { rules, node, literal } from 'parseman' with { type: 'macro' }
const noBuild = undefined
export const grammar = rules(g => ({
  T: node('T', literal('a'), noBuild, { tags: ['x'] }),
}))
`.trim()
    const result = transform(code)!

    expect(result.warnings).toEqual([])
    expect(result.code).toContain('"tags":["x"]')

    const grammar = evalMacroModule<{ T: (input: string, pos: number, ctx: Record<string, unknown>) => { ok: boolean; value?: unknown } }>(result.code, 'grammar')
    const parsed = grammar.T('a', 0, { trackLines: false, build: cstBuildHost({ tags: true }) })
    expect(parsed.ok).toBe(true)
    expect(parsed.value).toMatchObject({ _tag: 'node', type: 'T', tags: ['x'] })
  })

  it('evaluateExpr rejects unresolved node tags instead of dropping metadata', () => {
    const code = `node('X', literal('a'), { tags: runtimeTags })`
    expect(evaluateExpr(parseInit(code), new Map(), code)).toBeNull()
  })

  it('evaluateExpr rejects unsafe node option object shapes instead of lowering them', () => {
    const spread = `node('X', literal('a'), { tags: ['A'], ...runtime })`
    const computed = `node('X', literal('a'), { ['tags']: ['A'] })`

    expect(evaluateExpr(parseInit(spread), new Map(), spread)).toBeNull()
    expect(evaluateExpr(parseInit(computed), new Map(), computed)).toBeNull()
  })
})

describe('evaluator — anyValue edge forms', () => {
  it('reads regex literals and object literals for parser() opts', () => {
    const code = `parser({ trivia: /[ \\t]+/, captureTrivia: true }, literal('x'))`
    const expr = parseInit(`const p = ${code}`)
    const combi = evaluateExpr(expr, new Map(), code)
    expect(combi?._def.tag).toBe('grammar')
  })

  it('resolves computed member access on the rules() proxy', () => {
    const code = `rules(g => {
  const leaf = literal('a')
  const wrap = sequence(g['leaf'], g.leaf)
  return { leaf, wrap }
})`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    expect(map?.has('wrap')).toBe(true)
  })

  it('replays mfSrcs when a scoped combinator is referenced', () => {
    const combi = literal('a')
    const scope = new Map([['inner', { combi, mfSrcs: ['s => s.toUpperCase()'] }]])
    const mfs: string[] = []
    const outer = evaluateExpr(parseInit('inner'), scope, 'inner', mfs)
    expect(outer?._def.tag).toBe('literal')
    expect(mfs).toEqual(['s => s.toUpperCase()'])
  })
})

describe('evaluator — referencesAny', () => {
  it('detects identifiers from the import set or scope', () => {
    const expr = parseInit('sequence(literal, regex)')
    const names = new Set(['literal', 'regex'])
    const scope = new Map()
    expect(referencesAny(expr as Node, names, scope)).toBe(true)
    expect(referencesAny(parseInit('sequence(foo)') as Node, names, scope)).toBe(false)
    scope.set('foo', { combi: literal('x'), mfSrcs: [] })
    expect(referencesAny(parseInit('foo') as Node, names, scope)).toBe(true)
  })
})

describe('evaluator — transform / node / sepBy / oneOrMore', () => {
  it('evaluateExpr captures transform callback source in mapFnSources', () => {
    const code = `transform(literal('a'), s => s.toUpperCase())`
    const mfs: string[] = []
    const combi = evaluateExpr(parseInit(code), new Map(), code, mfs)
    expect(combi?._def.tag).toBe('transform')
    expect(mfs).toEqual(['s => s.toUpperCase()'])
    if (combi?._def.tag === 'transform') {
      expect(combi._def.fnSrc).toBe('s => s.toUpperCase()')
    }
  })

  it('evaluateExpr builds node() rules with optional unwrap', () => {
    const code = `node('X', literal('a'), () => null, { unwrap: true })`
    const combi = evaluateExpr(parseInit(code), new Map(), code)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.unwrap).toBe(true)
      expect(combi._def.buildSrc).toBe('() => null')
    }
  })

  it('evaluateExpr builds node() rules with optional collapse', () => {
    const code = `node('X', literal('a'), () => null, { collapse: true })`
    const combi = evaluateExpr(parseInit(code), new Map(), code)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.collapse).toBe(true)
      expect(combi._def.buildSrc).toBe('() => null')
    }
  })

  it('evaluateExpr builds node() rules with optional project', () => {
    const code = `node('X', sequence(literal('('), literal('a'), literal(')')), { project: 1 })`
    const combi = evaluateExpr(parseInit(code), new Map(), code)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.project).toBe(1)
      expect(combi._def.buildSrc).toBeUndefined()
    }
  })

  it('evaluateExpr rejects invalid node() project options', () => {
    expect(evaluateExpr(parseInit(`node('X', literal('a'), { project: -1 })`), new Map(), `node('X', literal('a'), { project: -1 })`)).toBeNull()
    expect(evaluateExpr(parseInit(`node('X', literal('a'), { project: someProject })`), new Map(), `node('X', literal('a'), { project: someProject })`)).toBeNull()
  })

  it('evaluateExpr rejects ambiguous node() unwrap+collapse options', () => {
    const code = `node('X', literal('a'), () => null, { unwrap: true, collapse: true })`
    expect(evaluateExpr(parseInit(code), new Map(), code)).toBeNull()
  })

  it('evaluateExpr covers wrapper factories used by macro grammars', () => {
    const code = `label('item', noTrivia(token(expect(literal('a'), 'a'))))`
    const combi = evaluateExpr(parseInit(code), new Map(), code)
    expect(combi?._def.tag).toBe('label')
    expect(parse(combi!, 'a').ok).toBe(true)
  })

  it('evaluateParserFactory infers node() types from rule keys', () => {
    const code = `rules(g => ({ Ident: node(regex(/[a-z]+/)) }))`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    const ident = map?.get('Ident')
    // The rule itself, not a `lazy` wrapping it — see the note on the `A` rule above.
    expect(ident?._def.tag).toBe('node')
    const result = run(ident!, 'abc', { build: cstBuildHost() })
    expect(result.value).toMatchObject({ _tag: 'node', type: 'Ident' })
  })

  it('evaluateExpr builds keyword parsers through the macro environment', () => {
    const code = `keywords(['if', 'else'], { caseInsensitive: true, boundary: 'A-Za-z' })`
    const combi = evaluateExpr(parseInit(code), new Map(), code)
    expect(combi?._def.tag).toBe('keywords')
    expect(parse(combi!, 'ELSE').ok).toBe(true)
    expect(parse(combi!, 'elsewhere').ok).toBe(false)
  })

  it('evaluateExpr resolves a bare ref() to a lazy slot and rejects ref(arg)', () => {
    const slot = evaluateExpr(parseInit('ref()'), new Map())
    expect(slot?._def.tag).toBe('lazy')
    expect(evaluateExpr(parseInit('ref(1)'), new Map())).toBeNull()
  })

  it('evaluateExpr returns null when a parser() opts arg is not statically evaluable', () => {
    const code = `parser(externalOpts, literal('a'))`
    expect(evaluateExpr(parseInit(code), new Map(), code)).toBeNull()
  })

  it('evaluateExpr returns null for a spread argument to a supported factory', () => {
    const code = `sequence(...terms)`
    expect(evaluateExpr(parseInit(code), new Map(), code)).toBeNull()
  })

  it('evaluateExpr returns null when an argument is an unresolvable value node', () => {
    // A template literal isn't a value anyValue can resolve, so literal(...) bails.
    const code = 'literal(`x`)'
    expect(evaluateExpr(parseInit(code), new Map(), code)).toBeNull()
  })

  it('sepBy and oneOrMore replay item mfSrcs to match codegen traversal', () => {
    const sepCode = `sepBy(transform(literal('a'), x => x), literal(','))`
    const sepMfs: string[] = []
    const sep = evaluateExpr(parseInit(sepCode), new Map(), sepCode, sepMfs)
    expect(sep?._def.tag).toBe('sepBy')
    expect(sepMfs.filter(s => s.includes('x => x')).length).toBe(2)

    const manyCode = `oneOrMore(transform(literal('b'), y => y))`
    const manyMfs: string[] = []
    const many = evaluateExpr(parseInit(manyCode), new Map(), manyCode, manyMfs)
    expect(many?._def.tag).toBe('oneOrMore')
    expect(manyMfs.filter(s => s.includes('y => y')).length).toBe(2)
  })
})

describe('evaluator — factory and define edge cases', () => {
  it('evaluateParserFactory accepts concise arrow return objects', () => {
    const code = `rules(g => ({ leaf: literal('x') }))`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    // The rule itself, not a `lazy` wrapping it — see the note on the `A` rule above.
    expect(map?.get('leaf')?._def.tag).toBe('literal')
    expect(parse(map!.get('leaf')!, 'x').ok).toBe(true)
  })

  it('evaluateWordFactory uses the default boundary when omitted', () => {
    expect(evaluateWordFactory(parseInit('makeWord()'), new Map())?.boundary).toBe('_0-9A-Za-z')
    expect(evaluateWordFactory(parseInit('makeWord()'), new Map())?.caseInsensitive).toBe(false)
  })

  it('evaluateWordFactory reads case-insensitive options', () => {
    expect(evaluateWordFactory(parseInit("makeWord('A-Za-z0-9_-', { caseInsensitive: true })"), new Map()))
      .toMatchObject({ boundary: 'A-Za-z0-9_-', caseInsensitive: true })
    expect(evaluateWordFactory(parseInit('makeWord({ caseInsensitive: true })'), new Map()))
      .toMatchObject({ boundary: '_0-9A-Za-z', caseInsensitive: true })
    expect(evaluateWordFactory(parseInit('makeWord(undefined, { caseInsensitive: true })'), new Map()))
      .toMatchObject({ boundary: '_0-9A-Za-z', caseInsensitive: true })
  })

  it('evaluateRefDeclaration rejects ref() with arguments', () => {
    const scope = new Map()
    expect(evaluateRefDeclaration(parseInit('ref(1)'), 'x', scope)).toBeNull()
    expect(scope.size).toBe(0)
  })

  it('applyDefineStatement rejects computed .define targets', () => {
    const scope = new Map()
    const init = parseInit('const item = ref()')
    evaluateRefDeclaration(init, 'item', scope)
    const code = 'item["define"](literal("x"))'
    expect(applyDefineStatement(parseInit(code), scope, code)).toBe(false)
  })

  it('evaluateParserFactory returns null when return is not an object literal', () => {
    const code = `rules(g => literal('a'))`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    expect(evaluateParserFactory(factory, new Map(), code, [])).toBeNull()
  })

  it('binds makeWord() factories in a rules() body via anyValue', () => {
    const code = `rules(g => {
  const mk = makeWord('A-Za-z', { caseInsensitive: true })
  const kw = mk('if')
  return { kw }
})`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    // The rule itself, not a `lazy` wrapping it — see the note on the `A` rule above.
    expect(map?.get('kw')?._def.tag).toBe('keywords')
    expect(parse(map!.get('kw')!, 'IF').ok).toBe(true)
  })
})


describe('transformMacro — spreads are not composable (compose() only)', () => {
  it('a `...spread` in a rules() map is not statically evaluable → interpreter fallback', () => {
    // Fragment-spread composition was removed; the ONE composition API is compose().
    // A spread property makes the factory non-statically-evaluable, so it warns and
    // falls back rather than being inlined.
    const code = `
import { rules, regex } from 'parseman' with { type: 'macro' }
const frag = (g) => ({ digit: regex(/[0-9]/) })
export const { leaf } = rules(g => ({ ...frag(g), leaf: regex(/a/) }))
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes("isn't statically evaluable"))).toBe(true)
  })
})
