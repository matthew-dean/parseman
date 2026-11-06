import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = new URL('../../bench/jess/ab-built.mjs', import.meta.url).pathname
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

describe('bench/jess/ab-built.mjs arguments', () => {
  it.each([
    ['one leg, which would compare nothing', ['f', 'a=m.js']],
    ['two legs with one name, which the row would keep as one', ['f', 'a=m.js', 'a=n.js']],
    ['equal parse counts, which divide by zero', ['--n1', '20', '--n2', '20', 'f', 'a=m.js', 'b=n.js']],
    ['falling parse counts', ['--n1', '120', '--n2', '20', 'f', 'a=m.js', 'b=n.js']],
    ['a repetition count that is not a number', ['--reps', 'many', 'f', 'a=m.js', 'b=n.js']],
    ['a parse count that is not a number', ['--n2', 'many', 'f', 'a=m.js', 'b=n.js']],
  ])('refuses %s before it runs a leg', (_, args) => {
    const result = run(...args)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage:')
  })

  it('reads a count past what a parser prints', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-built-'))
    try {
      const engine = join(root, 'node_modules/parseman')
      mkdirSync(engine, { recursive: true })
      writeFileSync(join(engine, 'package.json'), '{"name":"parseman","exports":{".":"./index.mjs","./oracle":"./index.mjs"}}')
      writeFileSync(join(engine, 'index.mjs'), 'export const digestValue = value => JSON.stringify(value)')
      const module = join(root, 'noisy.mjs')
      writeFileSync(module, "export const parse = text => { console.log('parsing'); return text }")
      const file = join(root, 'input')
      writeFileSync(file, 'x')
      const result = run('--reps', '0', file, `one=${module}`, `two=${module}`)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('tree same')
      expect(result.stdout).toMatch(/one +calls [1-9]/)
    } finally {
      rmSync(root, { recursive: true })
    }
  })

  it('names what each leg ran before any number', () => {
    const module = new URL(import.meta.url).pathname
    const result = run('--reps', '1', 'f', `one=${module}`, `two=${module}`)
    const real = realpathSync(module)
    expect(result.stdout).toContain(`one: built parser ${real}`)
    expect(result.stdout).toContain(`two: built parser ${real}`)
    expect(result.stdout).toContain('closure engine parseman at')
    expect(result.stdout).not.toContain('calls')
  })
})
