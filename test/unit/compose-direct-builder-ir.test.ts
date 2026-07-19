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

    const entries = evalRuleMapIR(ir)
    const direct = entries[0]![1]._def
    expect(direct.tag === 'node' && direct.buildStaticValidated).toBe(true)
    const pieces = compileLinkable(entries, '_direct_')!
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

  it('rejects malformed IR with a lexical direct builder that lacks macro validation', () => {
    const malformed = `({ Direct: _nd("Direct", literal("x"), "() => importedFactory()", undefined, undefined) })`
    expect(() => evalRuleMapIR(malformed)).toThrow(
      'IR direct node builder for Direct lacks macro static validation',
    )
    const invalid = `({ Direct: _nd("Direct", literal("x"), "() => importedFactory()", undefined, undefined, false) })`
    expect(() => evalRuleMapIR(invalid)).toThrow(
      'IR direct node builder for Direct lacks macro static validation',
    )
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
