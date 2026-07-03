/**
 * Targeted coverage for src/plugin/* — the largest uncovered area in the suite.
 * Exercises ref() macro pre-pass, destructure warning paths, module aliases,
 * and direct evaluator entry points not reached by parity tests alone.
 */
import { describe, it, expect, vi } from 'vitest'
import { parseSync } from 'oxc-parser'
import type { Expression, Node } from '@oxc-project/types'
import parsemanPlugin, { transformMacro } from '../../src/plugin/index.ts'
import {
  evaluateRefDeclaration,
  applyDefineStatement,
  evaluateParserFactory,
  evaluateWordFactory,
  evaluateCombinatorArray,
  evaluateExpr,
  referencesAny,
  asFragmentFactory,
  type FactoryAst,
  type FactoryResolver,
} from '../../src/plugin/evaluator.ts'
import { literal, parse, ref, sequence, optional } from '../../src/index.ts'

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
    const fnBody = result.code.replace(/\bexport const\b/g, 'const').replace(/\bconst\b/g, 'var') + '\nreturn brackets'
    type ParseFn = (input: string, pos: number, ctx: { trackLines: boolean }) => ReturnType<typeof parse>
    const compiled = new Function(fnBody)() as ParseFn

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
    expect(map?.get('A')?._def.tag).toBe('lazy')
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

  it('evaluateExpr builds node() rules with optional collapse', () => {
    const code = `node('X', literal('a'), () => null, { collapse: true })`
    const combi = evaluateExpr(parseInit(code), new Map(), code)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.collapse).toBe(true)
      expect(combi._def.buildSrc).toBe('() => null')
    }
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
    expect(map?.get('leaf')?._def.tag).toBe('lazy')
    expect(parse(map!.get('leaf')!, 'x').ok).toBe(true)
  })

  it('evaluateWordFactory uses the default boundary when omitted', () => {
    expect(evaluateWordFactory(parseInit('makeWord()'), new Map())?.boundary).toBe('_0-9A-Za-z')
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
  const mk = makeWord('A-Za-z')
  const kw = mk('if')
  return { kw }
})`
    const call = parseInit(`const m = ${code}`)
    const factory = (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
    const map = evaluateParserFactory(factory, new Map(), code, [])
    expect(map?.get('kw')?._def.tag).toBe('lazy')
    expect(parse(map!.get('kw')!, 'if').ok).toBe(true)
  })
})

function parseFragment(code: string): Expression {
  return parseInit(`const frag = ${code}`)
}

function factoriesFrom(code: string): FactoryResolver {
  const ast = parseSync('eval.ts', code)
  const factories = new Map<string, FactoryAst>()
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const decl of stmt.declarations) {
      const id = decl.id as { type: string; name?: string }
      const init = (decl as { init?: Expression }).init
      if (id.type === 'Identifier' && id.name && init) {
        const frag = asFragmentFactory(init)
        if (frag) factories.set(id.name, frag)
      }
    }
  }
  return (name) => {
    const fn = factories.get(name)
    return fn ? { fn, code } : null
  }
}

function rulesFactoryFrom(code: string): Expression {
  const call = parseInit(`const m = ${code}`)
  return (call as { type: 'CallExpression'; arguments: Expression[] }).arguments[0]!
}

describe('evaluator — grammar composition (fragment spreads)', () => {
  it('asFragmentFactory accepts concise and block-body factories', () => {
    expect(asFragmentFactory(parseFragment('(g) => ({ leaf: literal("x") })'))).not.toBeNull()
    expect(asFragmentFactory(parseFragment(`(g) => {
      const leaf = literal('x')
      return { leaf }
    }`))).not.toBeNull()
  })

  it('asFragmentFactory rejects non-factory shapes', () => {
    expect(asFragmentFactory(parseInit('literal("x")'))).toBeNull()
    expect(asFragmentFactory(parseFragment('(g) => 1'))).toBeNull()
    expect(asFragmentFactory(parseFragment(`(g) => {
      foo()
      return { leaf: literal('x') }
    }`))).toBeNull()
    expect(asFragmentFactory(parseFragment(`(g) => {
      return literal('x')
    }`))).toBeNull()
  })

  it('evaluateParserFactory inlines a registered ...frag(g) spread', () => {
    const prelude = `const numbers = (g) => ({ digit: regex(/[0-9]/), number: oneOrMore(g.digit) })`
    const factories = factoriesFrom(prelude)
    const code = `rules(g => ({ ...numbers(g), pair: sequence(g.number, literal(','), g.number) }))`
    const map = evaluateParserFactory(rulesFactoryFrom(code), new Map(), `${prelude}\n${code}`, [], factories)
    expect(map?.has('pair')).toBe(true)
    expect(parse(map!.get('pair')!, '12,34').ok).toBe(true)
    expect(parse(map!.get('pair')!, 'x,34').ok).toBe(false)
  })

  it('evaluateParserFactory inlines nested spreads and block-body fragment consts', () => {
    const prelude = `
const inner = (g) => ({ digit: regex(/[0-9]/) })
const outer = (g) => {
  const comma = literal(',')
  return { ...inner(g), comma, pair: sequence(g.digit, comma, g.digit) }
}`
    const factories = factoriesFrom(prelude)
    const code = `rules(g => ({ ...outer(g) }))`
    const map = evaluateParserFactory(rulesFactoryFrom(code), new Map(), `${prelude}\n${code}`, [], factories)
    expect(map?.has('pair')).toBe(true)
    expect(parse(map!.get('pair')!, '1,2').ok).toBe(true)
  })

  it('evaluateParserFactory returns null for unregistered or cyclic spreads', () => {
    const factories: FactoryResolver = () => null
    const missing = `rules(g => ({ ...missing(g), leaf: literal('x') }))`
    expect(evaluateParserFactory(rulesFactoryFrom(missing), new Map(), missing, [], factories)).toBeNull()

    const cycle = `
const a = (g) => ({ ...b(g), x: literal('a') })
const b = (g) => ({ ...a(g), y: literal('b') })`
    const cycleFactories = factoriesFrom(cycle)
    const code = `rules(g => ({ ...a(g) }))`
    expect(evaluateParserFactory(rulesFactoryFrom(code), new Map(), `${cycle}\n${code}`, [], cycleFactories)).toBeNull()
  })

  it('evaluateParserFactory returns null when a spread factory body is invalid', () => {
    const prelude = `const bad = (g) => { foo(); return { leaf: literal('x') } }`
    const factories = factoriesFrom(prelude)
    const code = `rules(g => ({ ...bad(g) }))`
    expect(evaluateParserFactory(rulesFactoryFrom(code), new Map(), `${prelude}\n${code}`, [], factories)).toBeNull()
  })

  it('evaluateParserFactory accepts string-literal rule keys in fragments', () => {
    const prelude = `const frag = (g) => ({ "tok": literal('x') })`
    const factories = factoriesFrom(prelude)
    const code = `rules(g => ({ ...frag(g) }))`
    const map = evaluateParserFactory(rulesFactoryFrom(code), new Map(), `${prelude}\n${code}`, [], factories)
    expect(map?.has('tok')).toBe(true)
    expect(parse(map!.get('tok')!, 'x').ok).toBe(true)
  })
})

describe('transformMacro — grammar composition warnings', () => {
  it('warns when a rules() spread references an unknown fragment factory', () => {
    const code = `
import { rules, regex } from 'parseman' with { type: 'macro' }
export const { leaf } = rules(g => ({ ...missing(g), leaf: regex(/a/) }))
`.trim()
    const result = transform(code)!
    expect(result.warnings.some(w => w.includes("isn't statically evaluable"))).toBe(true)
  })

  it('registers a fragment factory without warning and inlines a later spread', () => {
    const code = `
import { rules, regex, sequence, oneOrMore } from 'parseman' with { type: 'macro' }
const numbers = (g) => ({ digit: regex(/[0-9]/), number: oneOrMore(g.digit) })
export const { pair } = rules(g => ({
  ...numbers(g),
  pair: sequence(g.number, regex(/,/), g.number),
}))
`.trim()
    const result = transform(code)!
    expect(result.warnings).toEqual([])
    expect(result.code).not.toContain("from 'parseman'")
  })
})
