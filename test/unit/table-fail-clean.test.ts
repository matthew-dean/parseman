/**
 * A child whose failure writes nothing takes no rollback mark (`fail-clean.ts`).
 *
 * The mark reads the length of every live sink and the restore reads them again.
 * The trivia log here counts its `length` reads, so the test sees the mark that
 * an `optional()` of a terminal used to take on every miss. A child that writes
 * before it fails keeps its mark, and the tree shows the restore.
 */
import { describe, expect, it } from 'vitest'
import { literal, node, optional, regex, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { failCleanAnalysis } from '../../src/table/fail-clean.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble } from '../../src/table/assemble.ts'
import { FAIL } from '../../src/table/cell.ts'
import { resolveTable } from '../../src/table/program.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_OPT } from '../../src/table/ops.ts'

function countingLog(): { log: number[]; reads: () => number } {
  let n = 0
  const log = new Proxy<number[]>([], {
    get(target, key, receiver) {
      if (key === 'length') n++
      return Reflect.get(target, key, receiver)
    },
  })
  return { log, reads: () => n }
}

const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false }

/** The closure engine, with a live trivia log that counts the mark's reads. */
function parse(root: Combinator<unknown>, input: string): { value: unknown; reads: number } {
  const prog = { ...encodeTable({ Root: root }), asm: [] }
  const linked = assemble(resolveTable(prog), prog, CFG)
  const { log, reads } = countingLog()
  const ctx = createParseContext()
  ctx._triviaLog = log
  linked.begin(ctx)
  const v = linked.pieces.Root!(input, 0, ctx)
  linked.finish()
  return { value: v === FAIL ? 'FAIL' : v, reads: reads() }
}

const word = node('Word', regex(/[a-z]+/), children => children[0])

describe('a child that fails clean', () => {
  it('is tried with no mark to take or restore', () => {
    // Each optional's first character matches, so it is entered, and then misses.
    const root = sequence(optional(literal('ab')), optional(literal('ac')), literal('ad'))
    expect(parse(root, 'ad')).toEqual({ value: [null, null, 'ad'], reads: 0 })
  })

  it('keeps the mark where the child writes before it fails', () => {
    // `x:` pushes the word, then the colon is missing: the word must not stay.
    const root = node('Stmt', sequence(optional(sequence(word, literal(':'))), word, literal(';')),
      children => children.map(c => (c as { value: unknown }).value))
    expect(parse(root, 'x;').value).toEqual(['x', ';'])
    expect(parse(root, 'k:x;').value).toEqual(['k', ':', 'x', ';'])
  })

  it('is decided per row from the table', () => {
    const dirty = optional(sequence(word, literal(':')))
    const clean = optional(sequence(word, optional(literal(':'))))
    const prog = encodeTable({ Dirty: dirty, Clean: clean })
    const clean0 = failCleanAnalysis(prog.code)
    const child = (rule: string): number => {
      const opt = [...reachableIps({ ...prog, rules: { [rule]: prog.rules[rule]! } })].find(ip => prog.code[ip] === OP_OPT)!
      return prog.code[opt + 1]!
    }
    expect(clean0(child('Dirty'))).toBe(false)
    expect(clean0(child('Clean'))).toBe(true)
  })
})
