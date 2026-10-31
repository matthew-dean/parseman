/**
 * The closure engine's `dispatch()` holds its rollback mark in scalars, as a
 * choice does: no mark object per dispatch, none per arm. A routed arm reuses
 * the selector's mark, since undoing the selector leaves every sink there. The
 * `node()` around it keeps the capture sinks live, so a mark is due.
 */
import { describe, expect, it, vi } from 'vitest'
import * as triviaSkip from '../../src/combinators/trivia-skip.ts'
import { dispatch, literal, node, otherwise, regex, routed, sequence, when } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { run, type Runnable } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'

vi.mock('../../src/combinators/trivia-skip.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/combinators/trivia-skip.ts')>()
  return { ...real, saveTriviaMark: vi.fn(real.saveTriviaMark) }
})

const word = regex(/[a-z]+/)
const root: Combinator<unknown> = node('Stmt', dispatch(
  word,
  // `if` re-reads the word through `routed()`; `do` takes what follows it.
  when('if', sequence(routed(), literal('('), word, literal(')'))),
  when('do', sequence(literal(' '), word)),
  otherwise(sequence(routed(), literal(';'))),
), children => children)

describe('a closure dispatch', () => {
  it('takes no mark object', () => {
    const prog = encodeTable({ Root: root })
    const closure = tableRules({ ...prog, asm: [] }).Root! as Runnable
    const save = vi.mocked(triviaSkip.saveTriviaMark)
    save.mockClear()
    for (const input of ['if(x)', 'do y', 'z;', 'if(x', 'do', 'q']) run(closure, input)
    expect(save).not.toHaveBeenCalled()
  })

  it('parses and builds what the reference does, failures included', () => {
    const prog = encodeTable({ Root: root })
    const reference = execRules(prog).Root! as Runnable
    const closure = tableRules({ ...prog, asm: [] }).Root! as Runnable
    for (const input of ['if(x)', 'do y', 'z;', 'if(x', 'do', 'q', 'if', 'do  y']) {
      expect(digestValue(run(closure, input)), input).toBe(digestValue(run(reference, input)))
    }
  })
})
