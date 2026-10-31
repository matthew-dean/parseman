/**
 * Completions from the table engines match the interpreter: a sequence leaf
 * that fails feeds the probe, and a lookahead hides what its child raised
 * (`not.ts` / `peek.ts` roll `_probe.best` back).
 */
import { describe, expect, it } from 'vitest'
import {
  choice, keywords, literal, not, peek, regex, sequence, token,
} from '../../src/index.ts'
import type { Combinator, ParseContext, ParseFail } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules, cfgKey } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import type { Runnable } from '../../src/functional/run.ts'
import { createParseContext } from '../../src/parse-context.ts'

type Comb = Combinator<unknown>

/** A capability gap that keeps a whole program on the CHARACTER lowering. */
const GAP = token(sequence(
  literal('a'), literal('b'), literal('c'), literal('d'), literal('e'), literal('f'),
))

function emitted(prog: TableProgram): Record<string, Runnable> {
  const resolved = resolveTable(prog)
  const precompiled: PrecompiledAssembly[] = defaultAssemblyCfgs(prog).map(cfg => {
    const out = emitAssemblySource(resolved, prog, cfg, [])
    return {
      key: cfgKey(cfg),
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      factory: new Function(...EMITTED_PARAMS, out.source) as PrecompiledAssembly['factory'],
      plan: out.plan, reached: [...out.reached],
    }
  })
  return tableRules({ ...prog, asm: precompiled })
}

function readers(prog: TableProgram): ReadonlyArray<readonly [string, Record<string, Runnable>]> {
  return [
    ['reference', execRules(prog)],
    ['closure', tableRules({ ...prog, asm: [] })],
    ['emitted', emitted(prog)],
  ]
}

function probe(entry: Runnable, input: string): ParseFail | null {
  const ctx = createParseContext() as ParseContext & { _probe: { offset: number; best: ParseFail | null } }
  ctx._probe = { offset: input.length, best: null }
  ;(entry as (input: string, pos: number, ctx: ParseContext) => unknown)(input, 0, ctx)
  return ctx._probe.best
}

describe('character-path completions match the interpreter', () => {
  // Pre-existing table defects the lexical pins exposed: the reference driver's
  // sequence terminal fast path never fed the probe, and a generic lookahead
  // left its child's completions in it (`not.ts` rolls them back).
  it('reports a swallowed sequence opener and hides lookahead completions', () => {
    const roots = {
      Seq: token(choice(literal('$.'), sequence(literal('$^'), regex(/[a-z]+/)), sequence(literal('$'), regex(/[a-z]+/)))),
      Not: sequence(not(choice(keywords(['not']), sequence(literal('o'), regex(/r\b/)))), regex(/[a-z]+/)),
      Peek: sequence(peek(choice(keywords(['not']), sequence(literal('o'), regex(/r/)))), regex(/[a-z]+/)),
    }
    const character = encodeTable({ ...roots, Gap: GAP })
    const interp = (p: Comb, input: string): ParseFail | null => {
      const ctx = createParseContext() as ParseContext & { _probe: { offset: number; best: ParseFail | null } }
      ctx._probe = { offset: input.length, best: null }
      p.parse(input, 0, ctx)
      return ctx._probe.best
    }
    for (const [readerName, entries] of readers(character)) {
      for (const [name, inputs] of [['Seq', ['$a', '$^']], ['Not', ['or', 'ox']], ['Peek', ['or', 'ox']]] as const) {
        for (const input of inputs) {
          expect(probe(entries[name]!, input), `${readerName} ${name} ${input}`)
            .toEqual(interp(roots[name], input))
        }
      }
    }
  })
})
