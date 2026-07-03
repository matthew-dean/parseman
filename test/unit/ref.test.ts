import { describe, it, expect } from 'vitest'
import { ref, literal } from '../../src/index.ts'

describe('ref()', () => {
  it('throws if parse is called before define()', () => {
    const slot = ref<string>()
    expect(() => slot.parse('x', 0, { trackLines: false })).toThrow(
      'ref<T>() used before .define() was called',
    )
  })

  it('throws if define() is called twice', () => {
    const slot = ref<string>()
    slot.define(literal('a'))
    expect(() => slot.define(literal('b'))).toThrow('ref<T>() already defined')
  })

  it('throws if thunk is evaluated before define()', () => {
    const slot = ref<string>()
    const def = slot._def
    if (def.tag !== 'lazy') throw new Error('expected lazy ref')
    expect(() => def.thunk()).toThrow('ref<T>() used before .define() was called')
  })
})
