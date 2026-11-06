import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'leg-sweep-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A leg as `build-leg.mts` lays it out, whose parse throws on any input holding `boom`.
const leg = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'css-ast.mjs'), `
export const grammar = { Stylesheet: {} }
export const digestValue = v => JSON.stringify(v)
export const run = (_entry, input) => {
  if (input.includes('boom')) throw new Error('dead leg')
  return { ok: true, value: input, span: { start: 0, end: input.length }, errors: [], expected: [], unconsumedFrom: null }
}
`)
  return dir
}
const a = leg('a'), b = leg('b')

const sweep = (inputs: string[], ...flags: string[]) => {
  const file = join(root, 'inputs.json')
  writeFileSync(file, JSON.stringify(inputs.map(input => ['corpus:x', input])))
  return spawnSync(process.execPath, ['bench/jess/leg-sweep.mjs', file, 'css-ast', a, b, ...flags], { encoding: 'utf8' })
}

describe('leg sweep rows where both legs throw', () => {
  it('two dead legs do not pass', () => {
    const r = sweep(['boom', 'boom 2'])
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('both legs threw on 2 of 2 inputs')
    expect(JSON.parse(r.stdout.split('\n')[0]!)).toMatchObject({ same: 0, bothThrow: 2, bothThrowMessages: { 'dead leg': 2 } })
  })

  it('a few within the limit pass and are still reported', () => {
    const r = sweep(['boom', ...Array.from({ length: 20 }, (_, i) => `ok ${i}`)])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout.split('\n')[0]!)).toMatchObject({ same: 20, bothThrow: 1, bothThrowMessages: { 'dead leg': 1 } })
  })

  it('the limit is a flag', () => {
    expect(sweep(['boom', 'ok'], '--max-both-throw=0.5').status).toBe(0)
    expect(sweep(['boom', 'ok'], '--max-both-throw=0.4').status).toBe(3)
  })
})
