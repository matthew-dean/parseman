import { describe, expect, it } from 'vitest'
import type { FusedRule, Runnable } from '../../src/index.ts'

describe('FusedRule public contract', () => {
  it('is accepted anywhere Parseman accepts a compiled runnable', () => {
    const fused: FusedRule = (input, pos, ctx) => ({
      ok: true,
      value: { input, state: ctx.state },
      span: { start: pos, end: pos + input.length }
    })
    const runnable: Runnable = fused

    expect(runnable).toBe(fused)
  })
})
