import { describe, expect, it } from 'vitest'
import { choice, cstBuildHost, literal, node, regex, rules, sequence, type Combinator } from '../../src/index.ts'
// The interpreter's own driver: `run` from the package root lowers a combinator to a
// table first, which would make the interpreter leg a second table leg.
import { run } from '../../src/functional/run.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import type { BuildHost } from '../../src/types.ts'

/**
 * An ordered choice whose arms share a first char can only be split on what
 * follows it. Under a CST host every entered arm opens a node capture frame, so
 * an arm that must begin with a longer literal (`@{`, `@@`) is tested on that
 * literal before it is entered. These tests pin that the skip changes nothing a
 * caller can see — value, span, expected set — on either host, and that the
 * skipped arm is in fact never entered.
 */
type Entry = Parameters<typeof run>[0]

const name = regex(/[a-z]+/)
const arms = (wide: boolean): Combinator<unknown>[] => [
  node('Interp', sequence(literal('@{'), name, literal('}'))),
  node('Double', sequence(literal('@@'), name)),
  ...(wide ? [node('Keyword', sequence(literal('@kw'), literal('!')))] : []),
  node('Var', sequence(literal('@'), name)),
  ...(wide ? [node('Num', regex(/[0-9]+/))] : []),
]

function grammar(wide: boolean) {
  return rules(() => {
    const [a, b, ...rest] = arms(wide)
    return { Entry: choice(a!, b!, ...rest) }
  })
}

/** A CST host that records every structural node it is asked to open. */
function countingHost(entered: string[]): BuildHost {
  return Object.assign(
    (...args: Parameters<typeof cstBuildHost>) => cstBuildHost(...args),
    { _parsemanCstOutput: true as const, _parsemanTriviaKinds: (type: string) => { entered.push(type); return undefined } },
  ) as BuildHost
}

function outcome(entry: Entry, input: string, build?: BuildHost) {
  const r = run(entry, input, build === undefined ? {} : { build })
  return { ok: r.ok, value: r.value, span: r.span, expected: r.expected, unconsumedFrom: r.unconsumedFrom }
}

const INPUTS = ['@{ab}', '@@ab', '@kw!', '@kw', '@ab', '12', '@', '@{', '@{1}', '@@', 'x', '']

describe.each([['three arms', false], ['five arms', true]] as const)('literal pretest, %s', (_label, wide) => {
  const g = grammar(wide)
  const table = tableRules({ ...encodeTable({ Entry: g.Entry! }), asm: [] }).Entry! as Entry

  it('matches the interpreter on the AST and on a CST host', () => {
    for (const input of INPUTS) {
      expect(outcome(table, input), `ast ${JSON.stringify(input)}`).toEqual(outcome(g.Entry as Entry, input))
      expect(outcome(table, input, countingHost([])), `cst ${JSON.stringify(input)}`)
        .toEqual(outcome(g.Entry as Entry, input, countingHost([])))
    }
  })

  it('does not enter an arm whose leading literal is absent', () => {
    const entered: string[] = []
    expect(run(table, '@ab', { build: countingHost(entered) }).ok).toBe(true)
    expect(entered).toEqual(['Var'])
  })
})
