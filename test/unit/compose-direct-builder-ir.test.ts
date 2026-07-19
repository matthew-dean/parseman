/**
 * A macro-built grammar carries direct `node(..., build)` callbacks as IR so a
 * downstream compose can re-lower them. `_nd` used to restore only `buildSrc`,
 * leaving the live node structural; codegen then selected ctx.build/default CST
 * and silently erased the direct semantic value.
 */
import { describe, expect, it } from 'vitest'
import * as parseman from '../../src/index.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'
import { directBuilderUnsupportedBindings } from '../../src/plugin/direct-builder-static.ts'
import { emitFusedSource } from '../../src/compiler/linker.ts'
import { transformMacro } from '../../src/plugin/index.ts'

const COMPOSED_PIECES = Symbol.for('parseman.composedPieces')

function macroModule(source: string): Record<string, unknown> {
  const transformed = transformMacro(source, '/pkg/base.ts', new Set(['parseman']))!
  expect(transformed.warnings).toEqual([])
  const module: Record<string, unknown> = {}
  const body = transformed.code
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/export const (\w+)/g, 'module.$1')
  // eslint-disable-next-line no-new-func
  new Function('module', ...Object.keys(parseman), body)(module, ...Object.values(parseman))
  return module
}

const BASE_SOURCE = `import { rules, literal, node } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), (children, _fields, span) => ({
    kind: 'direct',
    span,
    children: [...children],
  })),
}))`

describe('compose over a macro-built direct node builder', () => {
  const base = macroModule(BASE_SOURCE).base as Record<string | symbol, unknown>

  it('retains direct builder identity through IR rehydration and static compilation', () => {
    const carried = base[COMPOSED_PIECES] as Array<{ ir: string }>
    const ir = carried[0]!.ir
    expect(ir).toContain('_nd')

    const pieces = compileLinkable(evalRuleMapIR(ir), '_direct_')!
    expect(pieces.buildFns).toEqual([])
    expect(() => emitFusedSource([pieces])).not.toThrow()

    const rehydrated = parseman.compose([{ [COMPOSED_PIECES]: [{ ...carried[0], ir }] } as never]) as unknown as Record<
      string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }
    >
    const host = () => ({ kind: 'host' })
    expect(rehydrated.Direct!('x', 0, { build: host }).value).toEqual({
      kind: 'direct', span: { start: 0, end: 1 }, children: [{ _tag: 'leaf', value: 'x', span: { start: 0, end: 1 } }],
    })
  })

  it('rejects a real imported builder capture when compose re-lowers the macro artifact', () => {
    const captured = macroModule(`import { rules, literal, node } from 'parseman' with { type: 'macro' }
import { importedFactory } from './ast-factory.ts'
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), () => importedFactory()),
}))`).base as Record<string | symbol, unknown>
    const carried = captured[COMPOSED_PIECES] as Array<{ ir?: string }>
    expect(carried[0]!.ir).toContain('["importedFactory"]')
    expect(() => parseman.compose([captured as never])).toThrow(
      'IR direct node builder for Direct must be macro-static and self-contained; unsupported binding(s): importedFactory',
    )
  })

  it('reports lexical reads from Oxc AST, without mistaking keys or member names for bindings', () => {
    expect(directBuilderUnsupportedBindings(
      '(children, _fields, span) => ({ kind: "Direct", span, values: children.map(item => ({ item })) })',
    )).toEqual([])
    expect(directBuilderUnsupportedBindings(
      '(_children) => importedFactory.create()',
    )).toEqual(['importedFactory'])
    expect(directBuilderUnsupportedBindings(
      '(value) => (value += 1, { value })',
    )).toEqual([])
    expect(directBuilderUnsupportedBindings('() => {')).toEqual(['invalid callback source'])
  })

  it('rejects a captured helper when compose lowers a macro-built grammar', () => {
    const captured = macroModule(`import { rules, literal, node } from 'parseman' with { type: 'macro' }
const lexicalHelper = () => 'captured'
export const base = rules(g => ({
  Direct: node('Direct', literal('x'), () => lexicalHelper()),
}))`).base as Record<string | symbol, unknown>
    const carried = captured[COMPOSED_PIECES] as Array<{ ir?: string }>
    expect(carried[0]!.ir).toContain('["lexicalHelper"]')
    const delta = parseman.rules(() => ({ Tail: parseman.literal('z') }))
    expect(() => parseman.compose([captured as never, delta])).toThrow(
      'IR direct node builder for Direct must be macro-static and self-contained; unsupported binding(s): lexicalHelper',
    )
  })

  it('keeps the direct value after composition with a second grammar', () => {
    const delta = parseman.rules(() => ({ Tail: parseman.literal('z') }))
    const composed = parseman.compose([base as never, delta]) as unknown as Record<
      string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }
    >
    const host = () => ({ kind: 'host' })
    expect(composed.Direct!('x', 0, { build: host }).value).toEqual({
      kind: 'direct', span: { start: 0, end: 1 }, children: [{ _tag: 'leaf', value: 'x', span: { start: 0, end: 1 } }],
    })
    expect(composed.Tail!('z', 0, {}).ok).toBe(true)
  })
})

describe('composeLeaf over imported recognition IR', () => {
  it('is macro-only and never delegates to runtime compose()', () => {
    expect(() => parseman.composeLeaf([])).toThrow(
      'composeLeaf(): requires Parseman macro lowering; runtime composition is forbidden',
    )
    expect(() => transformMacro(
      `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
export const parser = composeLeaf([unresolvedSyntax, rules(g => ({ Document: literal('x') }))])`,
      '/pkg/leaf-unresolved.ts', new Set(['parseman']),
    )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')
  })

  it('rejects direct builders in every pre-final grammar', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-compose-leaf-reject-'))
    try {
      const directBase = transformMacro(
        `import { literal, node, rules } from 'parseman' with { type: 'macro' }
export const directBase = rules(g => ({ Atom: node('Atom', literal('x'), () => ({ type: 'base' })) }))`,
        path.join(dir, 'direct-base.js'), new Set(['parseman']),
      )!
      expect(directBase.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'direct-base.js'), directBase.code)

      expect(() => transformMacro(
        `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { directBase } from './direct-base.js'
export const parser = composeLeaf([directBase, rules(g => ({ Document: literal('x') }))])`,
        path.join(dir, 'imported-direct.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')

      const semanticBase = transformMacro(
        `import { literal, rules, transform } from 'parseman' with { type: 'macro' }
export const semanticBase = rules(g => ({ Atom: transform(literal('x'), value => value.toUpperCase()) }))`,
        path.join(dir, 'semantic-base.js'), new Set(['parseman']),
      )!
      expect(semanticBase.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'semantic-base.js'), semanticBase.code)
      expect(() => transformMacro(
        `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { semanticBase } from './semantic-base.js'
export const parser = composeLeaf([semanticBase, rules(g => ({ Document: literal('x') }))])`,
        path.join(dir, 'semantic-transform.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')

      // A carried full piece from before the recognition-only marker is unknown,
      // even if it happens not to contain a builder. Leaf fusion must reject it
      // rather than infer safety from generated source text.
      fs.writeFileSync(path.join(dir, 'legacy.js'), `
export const legacy = Object.defineProperty({}, Symbol.for('parseman.composedPieces'), {
  value: [{ ns: 'legacy', keys: [], prelude: [], ruleFns: new Map(), wrappers: new Map(), firstSets: new Map(), deps: new Map(), needsEmptyTl: false, needsHostReads: false, mfFns: [], buildFns: [] }],
  enumerable: false,
})`)
      expect(() => transformMacro(
        `import { composeLeaf, literal, rules } from 'parseman' with { type: 'macro' }
import { legacy } from './legacy.js'
export const parser = composeLeaf([legacy, rules(g => ({ Document: literal('x') }))])`,
        path.join(dir, 'legacy-unknown.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')

      expect(() => transformMacro(
        `import { composeLeaf, literal, node, rules } from 'parseman' with { type: 'macro' }
export const parser = composeLeaf([
  rules(g => ({ Prior: node('Prior', literal('x'), () => ({ type: 'prior' })) })),
  rules(g => ({ Document: literal('x') })),
])`,
        path.join(dir, 'local-direct.ts'), new Set(['parseman']),
      )).toThrow('composeLeaf() must macro-fuse; runtime composition is forbidden')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps local direct builders lexical, static, and terminal', async () => {
    const os = await import('node:os')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-compose-leaf-'))
    try {
      const base = transformMacro(
        `import { rules, literal } from 'parseman' with { type: 'macro' }
export const syntax = rules(g => ({ Atom: literal('x') }))`,
        path.join(dir, 'syntax.js'), new Set(['parseman']),
      )!
      expect(base.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'syntax.js'), base.code)

      const leaf = transformMacro(
        `import { composeLeaf, node, rules } from 'parseman' with { type: 'macro' }
import { syntax } from './syntax.js'
import { makeAst } from './ast.js'
export const parser = composeLeaf([syntax, rules(g => ({ Document: node('Document', g.Atom, () => makeAst('made locally')) }))])`,
        path.join(dir, 'leaf.js'), new Set(['parseman']),
      )!
      expect(leaf.warnings).toEqual([])
      expect(/\bcomposeLeaf\s*\(/.test(leaf.code)).toBe(false)
      expect(/new Function/.test(leaf.code)).toBe(false)
      expect(leaf.code).not.toContain('composedPieces')
      expect(leaf.code).toContain('leafComposed')

      const strip = (code: string) => code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var')
      const parser = new Function('makeAst', strip(leaf.code) + '\nreturn parser')(
        (value: unknown) => ({ type: 'Ast', value }),
      ) as Record<string | symbol, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>
      expect(parser.Document!('x', 0, {}).value).toEqual({ type: 'Ast', value: 'made locally' })

      const marker = Symbol.for('parseman.leafComposed')
      expect(parser[marker]).toBe(true)
      expect(() => parseman.compose([parser as never])).toThrow(
        'compose: a composeLeaf() result is terminal and cannot be composed again',
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
