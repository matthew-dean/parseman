/**
 * `cstBuildHost()` is public API: called directly, it copies the caller's span exactly as
 * given. Only the two shapes parseman builds itself are rebuilt by a constructor.
 */
import { describe, expect, it } from 'vitest'
import { cstBuildHost } from '../../src/index.ts'

type Built = { span: Record<string, unknown> }
const build = (span: Record<string, unknown>, tags?: readonly string[]): Built =>
  cstBuildHost('T', [], undefined, span as { start: number; end: number }, [], [], undefined, tags) as Built

describe('cstBuildHost span copy', () => {
  const cases: Record<string, Record<string, unknown>> = {
    'an extra key': { start: 1, end: 2, file: 'a.css' },
    'reordered keys': { end: 2, start: 1 },
    'a partial line span': { start: 1, end: 2, startLine: 1 },
    'a full line span': { start: 1, end: 2, startLine: 1, startColumn: 2, endLine: 1, endColumn: 3 },
    'a plain span': { start: 1, end: 2 },
  }
  for (const tags of [undefined, ['t']]) {
    for (const [name, span] of Object.entries(cases)) {
      it(`keeps ${name} as given${tags ? ' (tagged host)' : ''}`, () => {
        const out = build(span, tags).span
        expect(out).not.toBe(span)
        expect(Object.keys(out)).toEqual(Object.keys(span))
        expect(out).toEqual(span)
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
      })
    }
  }
})
