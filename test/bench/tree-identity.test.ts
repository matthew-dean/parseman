import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { compareTrees } from '../../bench/tree-identity.ts'

const root = mkdtempSync(join(tmpdir(), 'tree-identity-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const leg = (name: string, parse: string): string => {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'index.js'), `export const parse = ${parse}\n`)
  return dir
}
const corpus = join(root, 'corpus')
mkdirSync(corpus)
writeFileSync(join(corpus, 'one.css'), 'a{}')

const twoLegs = async (name: string, parse: string) =>
  compareTrees({ a: leg(`${name}-a`, parse), b: leg(`${name}-b`, parse), corpus, exts: ['.css'] })

describe('tree identity counts a tree only where one was read', () => {
  it('a failed run result is not a tree', async () => {
    const r = await twoLegs('failed', '() => ({ ok: false, expected: [] })')
    expect(r).toMatchObject({ compared: 1, realTrees: 0, noTree: 1, mismatched: 0 })
  })

  it('a run that stopped early is not a tree', async () => {
    const r = await twoLegs('partial', '() => ({ ok: true, value: 1, unconsumedFrom: 1 })')
    expect(r).toMatchObject({ realTrees: 0, noTree: 1 })
  })

  it('a whole run and a plain tree are', async () => {
    expect(await twoLegs('whole', '() => ({ ok: true, value: 1, unconsumedFrom: null })')).toMatchObject({ realTrees: 1, noTree: 0 })
    expect(await twoLegs('plain', '() => ({ type: "Root" })')).toMatchObject({ realTrees: 1, noTree: 0 })
  })

  it('a tree against a failure is a real pair, and a mismatch', async () => {
    const r = await compareTrees({ a: leg('mix-a', '() => ({ type: "Root" })'), b: leg('mix-b', '() => ({ ok: false })'), corpus, exts: ['.css'] })
    expect(r).toMatchObject({ realTrees: 1, noTree: 0, mismatched: 1 })
  })
})
