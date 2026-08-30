import { describe, expect, it } from 'vitest'
import {
  assertInterpreterChecks, contextualizeInterpreterTimeout,
} from '../../bench/interpreter-optimize-support.ts'

describe('interpreter optimization harness support', () => {
  it('adds the measured leg to timeout errors and preserves the cause', () => {
    const timeout = Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' })
    const contextual = contextualizeInterpreterTimeout(timeout, 'graphql/chevrotain')

    expect(contextual).toBeInstanceOf(Error)
    expect((contextual as Error).message).toContain('graphql/chevrotain')
    expect((contextual as Error).cause).toBe(timeout)
  })

  it('returns non-timeout failures unchanged', () => {
    const failure = Object.assign(new Error('child failed'), { code: 1 })
    expect(contextualizeInterpreterTimeout(failure, 'json/parseman-interp')).toBe(failure)
  })

  it('turns a failed measurement invariant into a process-level error', () => {
    expect(() => assertInterpreterChecks([
      [true, 'kept'],
      [false, 'browser gate'],
    ])).toThrow(/browser gate/)
  })
})
