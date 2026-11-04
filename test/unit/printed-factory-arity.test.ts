/**
 * A printed assembly factory refuses an older runtime: one that passes fewer helpers than
 * the factory was printed with. Without the check, a 0.59.0 artifact on a 0.58 runtime
 * fails partway through its first parse, on whichever new helper it reaches first.
 */
import { describe, expect, it } from 'vitest'
import { literal, node, sequence } from '../../src/index.ts'
import { EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { defaultAssemblyCfgs, emitTableModule } from '../../src/table/emit.ts'
import { encodeTable } from '../../src/table/encode.ts'
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

  it('opens with an arity check against the helpers it was printed with', () => {
    expect(source).toContain(`factory:function(${EMITTED_PARAMS.join(',')}){if(arguments.length<${EMITTED_PARAMS.length})throw new Error(`)
  })

  it('throws a clear error when an older runtime passes fewer helpers', () => {
    const start = source.indexOf('factory:function(') + 'factory:'.length
    const text = source.slice(start, source.indexOf('\n},', start) + 2)
    const factory = new Function(`return ${text}`)() as (...args: unknown[]) => unknown
    expect(() => factory(...EMITTED_PARAMS.slice(0, -2).map(() => undefined)))
      .toThrow(`parseman: this parser was printed by parseman ${PARSEMAN_VERSION}; upgrade the parseman runtime to at least that version`)
  })
})
