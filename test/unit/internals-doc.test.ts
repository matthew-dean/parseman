/**
 * `docs/design/internals.md` lists every table opcode with its number. A new
 * opcode, or a renumbered one, must be added there too.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OP_NAMES } from '../../src/table/ops.ts'

const doc = readFileSync(new URL('../../docs/design/internals.md', import.meta.url), 'utf8')
const rows = new Map<string, number>()
for (const m of doc.matchAll(/^\| (\d+) \| `([A-Z0-9_]+)` \|/gm)) rows.set(m[2]!, Number(m[1]))

describe('internals.md opcode table', () => {
  it('lists every opcode under its number, and nothing else', () => {
    const want = new Map(Object.entries(OP_NAMES).map(([n, name]) => [name, Number(n)]))
    expect(rows).toEqual(want)
  })
})
