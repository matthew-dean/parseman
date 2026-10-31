/**
 * A node whose body opens with `not`/`peek` of a direct terminal opens its
 * capture frame after that lookahead, not before: a node that fails on its
 * lookahead opens none, and on success the lookahead is not recognized again.
 * Closure engine; the parse, the tree and every failure are the reference's.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, node, not, peek, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'

let recognized = 0
const at = regex(/@/)
const g = rules({ trivia: regex(/ +/) }, (r: Record<string, Combinator<unknown>>) => ({
  // A guarded ruleset and a declaration share their first characters; the guard
  // is a lookahead the guarded arm opens with.
  Root: choice(r.Guarded!, r.Decl!),
  Guarded: node('Guarded', sequence(not(at), r.Word!, literal('{'), literal('}')), children => ({ guarded: children })),
  Decl: node('Decl', sequence(peek(regex(/[a-z@]/)), r.Word!, literal(':'), r.Word!), children => ({ decl: children })),
  Word: node('Word', regex(/@?[a-z]+/), children => {
    recognized++
    return (children[0] as { value: string }).value
  }),
})) as Record<string, Combinator<unknown>>

const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false }

function frames(prog: TableProgram, input: string): number {
  const linked = assemble(resolveTable(prog), prog, CFG)
  const seen = new Set<unknown>()
  let n = 0
  const ctx = new Proxy(createParseContext(), {
    set(target, key, value) {
      if ((key === '_cstBuf' || key === '_cstChildren') && value !== undefined && !seen.has(value)) { seen.add(value); n++ }
      return Reflect.set(target, key, value)
    },
  }) as ParseContext
  linked.begin(ctx)
  linked.pieces.Root!(input, 0, ctx)
  linked.finish()
  return n
}

describe('a node led by a lookahead', () => {
  it('opens no frame when the lookahead fails', () => {
    const prog = { ...encodeTable(g), asm: [] }
    // `@x: y` fails Guarded on `not(@)`, then parses as a Decl: the Decl and its
    // two words open frames, Guarded none.
    expect(frames(prog, '@x: y')).toBe(3)
  })

  it('parses, builds and fails as the reference does', () => {
    const prog = encodeTable(g)
    const reference = execRules(prog).Root! as Runnable
    const closure = tableRules({ ...prog, asm: [] }).Root! as Runnable
    for (const input of ['a {}', 'a{ }', '@x: y', 'x: y', '@a {}', '{}', '', 'a', 'a {', '@', ': y', 'a: ', '  a {}']) {
      recognized = 0
      const want = digestValue(run(reference, input))
      const wantWords = recognized
      recognized = 0
      expect(digestValue(run(closure, input)), input).toBe(want)
      expect(recognized, `${input} words built`).toBe(wantWords)
    }
  })
})
