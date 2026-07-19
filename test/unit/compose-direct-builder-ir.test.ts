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
  Direct: node('Direct', literal('x'), () => 'direct'),
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
    expect(rehydrated.Direct!('x', 0, { build: host }).value).toBe('direct')
  })

  it('keeps the direct value after composition with a second grammar', () => {
    const delta = parseman.rules(() => ({ Tail: parseman.literal('z') }))
    const composed = parseman.compose([base as never, delta]) as unknown as Record<
      string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }
    >
    const host = () => ({ kind: 'host' })
    expect(composed.Direct!('x', 0, { build: host }).value).toBe('direct')
    expect(composed.Tail!('z', 0, {}).ok).toBe(true)
  })
})
