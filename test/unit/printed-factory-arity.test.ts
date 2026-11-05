/**
 * A printed assembly factory refuses a runtime that passes a different number of helpers
 * than the factory was printed with, fewer or more. Helpers bind by position, so without
 * the check a 0.60.0 artifact on a 0.59 runtime (61 helpers) loads and then fails partway
 * through its first parse (`_SP is not a constructor`).
 */
import { describe, expect, it } from 'vitest'
import { literal, node, sequence } from '../../src/index.ts'
import { EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { defaultAssemblyCfgs, emitTableModule } from '../../src/table/emit.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { expandCompact, type CompactProgram } from '../../src/table/program.ts'
import { PARSEMAN_VERSION } from '../../src/version.ts'

describe('printed assembly factory', () => {
  const prog = encodeTable({ Entry: node('Pair', sequence(literal('a'), literal('b'))) })
  const source = emitTableModule(prog, {
    name: 'grammar',
    runtime: 'parseman/table',
    runtimeRef: 'tableRules',
    fnSources: prog.fns.map(fn => String(fn)),
    assemblies: defaultAssemblyCfgs(prog),
  })

  it('records its helper count, and opens with a check against the count it is called with', () => {
    expect(source).toContain(`arity:${EMITTED_PARAMS.length},factory:function(${EMITTED_PARAMS.join(',')}){if(arguments.length!==${EMITTED_PARAMS.length})throw new Error(`)
  })

  const start = source.indexOf('factory:function(') + 'factory:'.length
  const text = source.slice(start, source.indexOf('\n},', start) + 2)
  const factory = new Function(`return ${text}`)() as (...args: unknown[]) => unknown
  const refusal = `parseman: this parser was printed by parseman ${PARSEMAN_VERSION}; run it on parseman ${PARSEMAN_VERSION} or reprint it`

  it('throws a clear error when a runtime passes fewer helpers', () => {
    expect(() => factory(...EMITTED_PARAMS.slice(0, -2).map(() => undefined))).toThrow(refusal)
  })

  it('throws a clear error when a runtime passes more helpers, as a 0.59 runtime does', () => {
    expect(() => factory(...[...EMITTED_PARAMS, 'a', 'b', 'c'].map(() => undefined))).toThrow(refusal)
  })
})

describe('printed table wire form', () => {
  it('refuses a table printed before the token pool, and says what to do', () => {
    const prog = encodeTable({ Entry: node('Pair', sequence(literal('a'), literal('b'))) })
    // The wire form before the pool: expected sets spell out their strings, and there is no `es`.
    const older = { c: prog.code, k: prog.k, x: prog.cc, e: prog.fx, d: prog.disp, r: prog.rules, f: prog.fns }
    expect(() => expandCompact(older as unknown as CompactProgram))
      .toThrow(`parseman: this parser was printed by an earlier parseman; reprint it with parseman ${PARSEMAN_VERSION}`)
  })
})
