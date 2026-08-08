import { describe, expect, it } from 'vitest'
import { assertWorkloadFullyConsumed } from '../../bench/workloads/consumption.ts'
import { buildWorkloads } from '../../bench/workloads/index.ts'

describe('workload full-consumption guard', () => {
  it('goes RED on the formerly accepted successful partial span', () => {
    expect(() => assertWorkloadFullyConsumed(
      'reference',
      'css/stylesheet',
      'a\n',
      { ok: true, value: {}, span: { start: 0, end: 1 } },
    )).toThrow('stopped at byte 1 of 2')
  })

  it('goes RED when a driver explicitly reports unconsumed input', () => {
    expect(() => assertWorkloadFullyConsumed(
      'head',
      'json/document',
      '[]junk',
      { ok: true, value: [], span: { start: 0, end: 6 }, unconsumedFrom: 2 },
    )).toThrow('left input unconsumed from byte 2')
  })

  it('checks failure before interpreting consumption fields', () => {
    expect(() => assertWorkloadFullyConsumed(
      'head',
      'graphql/document',
      'query',
      { ok: false, span: { start: 0, end: 5 }, unconsumedFrom: 0 },
    )).toThrow('parse FAILED')
  })

  it('fails closed when a successful result has no span', () => {
    expect(() => assertWorkloadFullyConsumed(
      'head',
      'json/document',
      '[]',
      { ok: true, value: [] },
    )).toThrow('successful parse has no span')
  })

  it('rejects a parse that did not start at byte zero', () => {
    expect(() => assertWorkloadFullyConsumed(
      'reference',
      'css/stylesheet',
      'a',
      { ok: true, value: {}, span: { start: 1, end: 1 } },
    )).toThrow('started at 1, not byte 0')
  })

  it('accepts only an exact successful parse', () => {
    expect(() => assertWorkloadFullyConsumed(
      'head',
      'json/document',
      '[]',
      { ok: true, value: [], span: { start: 0, end: 2 }, unconsumedFrom: null },
    )).not.toThrow()
  })

  it('pins exact full consumption for all five production workloads', () => {
    for (const workload of buildWorkloads()) {
      expect(() => assertWorkloadFullyConsumed(
        'test',
        workload.id,
        workload.input,
        workload.make().parse(),
      ), workload.id).not.toThrow()
    }
  })
})
