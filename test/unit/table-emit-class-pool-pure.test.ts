/**
 * A printed table's char-class pool, in its compact `"…".split("…")` form, is
 * annotated pure: a bundler then drops the pool of a sibling variant it shook
 * out, as it drops that variant's other dead top-level statements.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, regex, rules, sequence } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { emitTableOnly } from '../../src/table/emit.ts'

describe('the printed class pool', () => {
  it('marks its split call pure', () => {
    // Enough first-character classes that the joined string beats the array.
    const arms = 'abcdefghijklmnop'.split('').map(c => sequence(literal(c), regex(/[0-9]+/)))
    const g = rules(() => ({ Root: choice(...(arms as [never, ...never[]])) }))
    const printed = emitTableOnly(encodeTable(g as never))
    expect(printed).toMatch(/\.split\(/)
    expect(printed).toMatch(/\/\* @__PURE__ \*\/ "[^"]*"\.split\("."\)/)
  })
})
