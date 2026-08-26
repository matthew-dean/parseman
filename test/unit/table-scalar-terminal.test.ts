import { describe, expect, it } from 'vitest'
import { OP_LIT } from '../../src/table/ops.ts'
import { makeScalarRecognizer } from '../../src/table/scalar-terminal.ts'

describe('scalar terminal recognizers', () => {
  it('recognizes two- and three-character literals at an offset', () => {
    const two = makeScalarRecognizer(OP_LIT, 'ab')!
    const three = makeScalarRecognizer(OP_LIT, 'xyz')!

    expect(two('zab', 1)).toBe(3)
    expect(two('zac', 1)).toBe(-1)
    expect(three('_xyz', 1)).toBe(4)
    expect(three('_xy!', 1)).toBe(-1)
  })
})
