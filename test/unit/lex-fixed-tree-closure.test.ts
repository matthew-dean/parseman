/**
 * Fixed lexical bodies that close the Jess grammars' capability gaps. Each body
 * is pinned against the CHARACTER lowering of the same grammar — the build a
 * capability gap forces — in every reader: the reference driver, the closure
 * assembly and the precompiled emitted assembly. A run's whole result is
 * compared (value, span, expected, unconsumedFrom), as is the completion probe's
 * best failure, on accepting and failing inputs, with the token bare and inside
 * an enclosing choice whose expected sets merge with the token's.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, keywords, literal, noTrivia, not, regex, sequence, token,
} from '../../src/index.ts'
import type { Combinator, ParseContext, ParseFail } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules, cfgKey } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { resolveTable, type PrecompiledAssembly, type TableProgram } from '../../src/table/program.ts'
import { defaultAssemblyCfgs } from '../../src/table/emit.ts'
import { emitAssemblySource, EMITTED_PARAMS } from '../../src/table/emit-assembly.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import { OP_LEX_PROGRAM, OP_TOKEN } from '../../src/table/ops.ts'

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

/**
 * `grammar(r)` builds `{ Root, Wrapped, ... }` where `Root` is the token under
 * test. The selected build must lower `Root` to one lexical program; the
 * character build is the same map plus GAP.
 */
function pinSelectedToCharacter(
  grammar: Record<string, Comb>,
  inputs: readonly string[],
): void {
  const selected = encodeTable(grammar)
  expect(selected.code[selected.rules.Root!], 'Root lowers to one lexical program').toBe(OP_LEX_PROGRAM)
  expect([...reachableIps(selected)].map(ip => selected.code[ip])).not.toContain(OP_TOKEN)
  const character = encodeTable({ ...grammar, Gap: GAP })
  expect(character.code[character.rules.Root!], 'the gap keeps the CHARACTER lowering').toBe(OP_TOKEN)
  const characterReaders = readers(character)
  for (const [readerName, selectedRules] of readers(selected)) {
    const characterRules = characterReaders.find(([name]) => name === readerName)![1]
    for (const rule of Object.keys(grammar)) {
      for (const input of inputs) {
        const label = `${readerName} ${rule} ${JSON.stringify(input)}`
        expect(digestValue(run(selectedRules[rule]!, input)), label)
          .toBe(digestValue(run(characterRules[rule]!, input)))
        expect(probe(selectedRules[rule]!, input), `probe ${label}`)
          .toEqual(probe(characterRules[rule]!, input))
      }
    }
  }
}

const wrap = (root: Comb): Record<string, Comb> => ({
  Root: root,
  Wrapped: choice(sequence(root, literal(';')), literal('!'), regex(/[a-z]+#/)),
})

describe('fixed lexical choice of any arity', () => {
  // The .jess variable-reference token: `$.`, `$^name`, `$name`.
  const jessVariable = token(noTrivia(choice(
    literal('$.'),
    sequence(literal('$^'), regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)),
    sequence(literal('$'), regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/)),
  )))

  it('lowers a 3-arm ordered choice with the character expected sets', () => {
    pinSelectedToCharacter(wrap(jessVariable),
      ['$.', '$^a', '$a', '$^', '$', '$1', 'x', '', '$a;', '$.;', '!', 'ab#'])
  })

  // The Less media-query word: not a connective, not `only`, then an identifier.
  const connective = token(noTrivia(choice(
    keywords(['not', 'only', 'and', 'or', 'from', 'to'], { caseInsensitive: true, boundary: '-_a-zA-Z0-9' }),
    regex(/and(?![-_a-zA-Z0-9])/i),
    regex(/or(?![-_a-zA-Z0-9])/i),
  )))
  const queryWord = token(noTrivia(sequence(
    not(connective),
    not(keywords(['only'], { caseInsensitive: true, boundary: '-_a-zA-Z0-9' })),
    regex(/-?[_a-zA-Z][-_a-zA-Z0-9]*/),
  )))

  it('lowers a 3-arm choice under a negative assertion', () => {
    pinSelectedToCharacter(wrap(queryWord),
      ['not', 'ONLY', 'and', 'or', 'from', 'nothing', 'orange', 'x', '1', '', 'x;', 'and;', 'ab#'])
  })
})
