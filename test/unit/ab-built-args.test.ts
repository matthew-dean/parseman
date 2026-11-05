import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = new URL('../../bench/jess/ab-built.mjs', import.meta.url).pathname
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

describe('bench/jess/ab-built.mjs arguments', () => {
  it.each([
    ['one leg, which would compare nothing', ['f', 'a=m.js']],
    ['two legs with one name, which the row would keep as one', ['f', 'a=m.js', 'a=n.js']],
    ['equal parse counts, which divide by zero', ['--n1', '20', '--n2', '20', 'f', 'a=m.js', 'b=n.js']],
    ['falling parse counts', ['--n1', '120', '--n2', '20', 'f', 'a=m.js', 'b=n.js']],
    ['a parse count that is not a number', ['--n2', 'many', 'f', 'a=m.js', 'b=n.js']],
  ])('refuses %s before it runs a leg', (_, args) => {
    const result = run(...args)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })
})
