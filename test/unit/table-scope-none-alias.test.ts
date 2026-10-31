/**
 * A scope with no trivia, where the labels prove no trivia is in force (inside a
 * `token()`), runs as its child in both table engines: it would write the
 * trivia, kind labels and scanner already there (`site-labels.ts`
 * `scopeIsIdentity`). The tree is the reference's.
 */
import { describe, expect, it } from 'vitest'
import { literal, node, noTrivia, optional, regex, rules, sequence, token } from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'

const g = rules({ trivia: regex(/ +/) }, (r: Record<string, Combinator<unknown>>) => ({
  // A no-trivia scope under the grammar's trivia is a real switch: `=1` is glued.
  Root: sequence(r.Name!, optional(noTrivia(sequence(literal('='), regex(/[0-9]+/)))), literal(';')),
  // The shape of a property name: an optional hack prefix glued to the word. The
  // node keeps the token a generic one, not a selected lexical body.
  Name: token(noTrivia(sequence(optional(literal('*')), node('Word', regex(/[a-z]+/), children => children[0])))),
})) as Record<string, Combinator<unknown>>

const CFG = { hostCst: false, hostReadsChildren: true, trackLines: false, tolerant: false, coverage: false, probe: false }

function emittedOf(prog: TableProgram): TableProgram {
  const { asm: _none, ...rest } = prog
  return rest
}

/** How many times the parse writes `ctx.trivia`. */
function triviaWrites(prog: TableProgram, input: string): number {
  const linked = assemble(resolveTable(prog), prog, CFG)
  let n = 0
  const ctx = new Proxy(createParseContext(), {
    set(target, key, value) {
      if (key === 'trivia') n++
      return Reflect.set(target, key, value)
    },
  }) as ParseContext
  linked.begin(ctx)
  linked.pieces.Root!(input, 0, ctx)
  linked.finish()
  return n
}

describe('a no-trivia scope under no trivia', () => {
  it('writes no trivia of its own in either engine', () => {
    const prog = encodeTable(g)
    // The token's clear and restore remain, and the word node's rule-entry scope.
    const closure = triviaWrites({ ...prog, asm: [] }, 'ab ;')
    const emitted = triviaWrites(emittedOf(prog), 'ab ;')
    expect({ closure, emitted }).toEqual({ closure: 4, emitted: 4 })
  })

  it('parses what the reference parses', () => {
    const prog = encodeTable(g)
    const reference = execRules(prog).Root! as Runnable
    const engines = { closure: tableRules({ ...prog, asm: [] }).Root!, emitted: tableRules(emittedOf(prog)).Root! }
    for (const input of ['ab;', '*ab ;', '* ab;', '*;', ';', 'ab', ' ab;', 'ab=1;', 'ab =1 ;', 'ab= 1;', 'ab=;']) {
      for (const [name, e] of Object.entries(engines)) {
        expect(digestValue(run(e as Runnable, input)), `${name} ${input}`).toBe(digestValue(run(reference, input)))
      }
    }
  })
})
