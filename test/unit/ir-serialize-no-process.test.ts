import { describe, expect, it, vi } from 'vitest'
import { serializeRuleMap } from '../../src/compiler/ir-serialize.ts'
import { literal, transform } from '../../src/index.ts'

describe('IR serialization runs without a `process` global', () => {
  // `compileLinkableTable()` serializes at run time, so this runs in browsers. Its
  // fallback once read `process.env.PARSEMAN_IR_DEBUG` unguarded and threw there.
  it('falls back to null for a grammar it cannot carry', () => {
    // A transform built at run time has no captured source, so it has no IR.
    const ruleMap = [['Entry', transform(literal('a'), v => v)]] as const
    expect(serializeRuleMap(ruleMap)).toBeNull()
    vi.stubGlobal('process', undefined)
    try {
      expect(serializeRuleMap(ruleMap)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
