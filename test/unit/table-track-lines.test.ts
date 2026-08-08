import { describe, expect, it } from 'vitest'
import { choice, expect as expectC, literal, regex, rules, sequence, trivia } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { compile } from '../../src/table/compile.ts'
import { OP_RULE } from '../../src/table/ops.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'
import type { TableProgram } from '../../src/table/program.ts'

/**
 * `rules({ trackLines: true }, …)` MUST ENCODE TO A TABLE THAT PARSES.
 *
 * `rules()` does not merely stamp `trackLines` on its rules: it REPLACES every
 * map entry with `parser({ trackLines: true }, entry)` carrying the same
 * `_ruleName` (`combinators/parser.ts:228-241`). When the entry was a lazy proxy
 * — which it is for any rule the factory forward-references or that recurses —
 * the map now binds that name to a WRAPPER AROUND THE RULE'S OWN REFERENCE.
 *
 * The encoder resolves a `g.X` by name through `Encoder.winners`, and it used to
 * decline that only on OBJECT IDENTITY (`winner !== p`). The wrapper defeats that
 * check: the proxy resolves by name to the wrapper already in flight, `node()`
 * hands back the recursion trampoline it reserved, and `case 'grammar'` — a
 * `parser()` scope with no trivia, no capture and no root policy emits NO ROW —
 * returns that trampoline as the wrapper's own body offset. The trampoline is
 * then patched to ITSELF.
 *
 * `OP_RULE ip → ip` makes no progress in either driver, so the failure is not
 * subtle and it is not partial: every file of every corpus died on its first byte
 * with `Maximum call stack size exceeded`, in all four `*PositionsGrammar`
 * variants of all four shipping grammars, and the rule's real body was never
 * encoded at all. It was introduced with the by-name map (`dccb7fa`) and was
 * live through `90aa867`.
 *
 * WHY A STRUCTURAL ASSERTION AND A PARSE. The parse alone is the outcome that
 * matters, but a self-referential row is a property of the TABLE, and asserting
 * it directly is what names the defect when a future encoder change reintroduces
 * it by a different route. Both drivers are exercised because both consume the
 * same encoding: `exec.ts` recurses on the same `ip`, `assemble.ts` builds a
 * piece that calls itself.
 */

/** Every reachable `OP_RULE` row whose target is the row itself. */
function selfLoops(prog: TableProgram): number[] {
  const code = prog.code
  return [...reachableIps(prog)]
    .filter(ip => code[ip] === OP_RULE && code[ip + 1] === ip)
    .sort((a, b) => a - b)
}

/**
 * The smallest grammar that reproduces it: ONE self-recursive rule.
 *
 * Recursion is not incidental. `g.Nest` is what makes `cache.Nest` a lazy proxy
 * rather than the combinator itself, and only a proxy gets wrapped into the shape
 * above — a rule nothing ever references is stored directly and encodes fine.
 */
const nest = (): Record<string, Combinator<unknown>> => rules(
  { trackLines: true },
  (g: Record<string, Combinator<unknown>>) => ({
    Nest: choice(sequence(literal('('), g.Nest!, literal(')')), literal('x')),
  }),
) as unknown as Record<string, Combinator<unknown>>

/** The same rule with no `trackLines`, as the size floor a tracked table must clear. */
const untracked = (): Record<string, Combinator<unknown>> => rules(
  (g: Record<string, Combinator<unknown>>) => ({
    Nest: choice(sequence(literal('('), g.Nest!, literal(')')), literal('x')),
  }),
) as unknown as Record<string, Combinator<unknown>>

/** The same shape with ambient trivia, which is what the shipping grammars have. */
const spaced = (): Record<string, Combinator<unknown>> => rules(
  { trivia: trivia(regex(/\s+/)), trackLines: true },
  (g: Record<string, Combinator<unknown>>) => ({
    List: sequence(literal('['), g.Item!, literal(']')),
    Item: choice(g.List!, regex(/[a-z]+/)),
  }),
) as unknown as Record<string, Combinator<unknown>>

describe('table lowering of rules({ trackLines: true })', () => {
  it('emits no rule row that trampolines to itself', () => {
    expect(selfLoops(encodeTable(nest(), { trackLines: true }))).toEqual([])
    expect(selfLoops(encodeTable(spaced(), { trackLines: true }))).toEqual([])
  })

  it('encodes the rule BODY, not a stub', () => {
    // The self-loop did not merely misroute — the body was never encoded at all,
    // and the whole table came out as the two words of the trampoline. A tracked
    // table is not byte-identical to an untracked one (the tracking opcodes are
    // different rows), but it cannot be SMALLER than one.
    //
    // The comparison is against a SEPARATE untracked `rules()` call, not against
    // `encodeTable(nest())`. `rules({ trackLines: true })` stamps
    // `grammarTrackLines` on every rule and `encodeTable` folds any such stamp
    // into the table's own tracking (`hasScopedTrackLines`), so dropping the
    // SETTING encodes exactly the same tracked table — both sides of that
    // comparison carried the defect and it asserted nothing.
    const tracked = encodeTable(nest(), { trackLines: true })
    const plain = encodeTable(untracked())
    expect(reachableIps(tracked).size).toBeGreaterThanOrEqual(reachableIps(plain).size)
  })

  it('parses through both drivers, identically to the interpreter', () => {
    for (const [name, build, rule, input] of [
      ['nest', nest, 'Nest', '((x))'],
      ['spaced', spaced, 'List', '[ [ ab ] ]'],
    ] as const) {
      const settings = { trackLines: true } as const
      const interp = run(build()[rule] as never, input)
      const exec = run(execRules(encodeTable(build(), settings))[rule] as never, input)
      const closure = run(tableRules(encodeTable(build(), settings))[rule] as never, input)
      expect(interp.ok, name).toBe(true)
      expect(exec, `${name}: exec.ts driver`).toEqual(interp)
      expect(closure, `${name}: assemble.ts driver`).toEqual(interp)
    }
  })

  it('annotates line and column, which is the whole point of the variant', () => {
    // A table that parsed but dropped the tracking would satisfy every assertion
    // above; `trackLines` exists to put `line`/`column` on the span.
    const prog = encodeTable(spaced(), { trackLines: true })
    expect(prog.lines).toBe(1)
    const r = run(execRules(prog)['List'] as never, '[\n  [ ab ]\n]')
    expect(r.ok).toBe(true)
    expect(r.span).toMatchObject({ startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 })
  })

  it('annotates zero-width expect() recovery errors in every table engine', () => {
    const grammar = rules(
      { trackLines: true },
      () => ({ Doc: sequence(literal('a\n'), expectC(literal('x'), 'x')) }),
    ) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(grammar, { trackLines: true })
    const input = 'a\n'
    const expectedSpan = {
      start: 2, end: 2,
      startLine: 2, startColumn: 1,
      endLine: 2, endColumn: 1,
    }

    const interpreter = run(grammar.Doc! as never, input, { tolerant: true })
    const reference = run(execRules(prog).Doc! as never, input, { tolerant: true })
    const assembled = run(tableRules(prog).Doc! as never, input, { tolerant: true })
    const compiled = compile(grammar.Doc!, undefined, { trackLines: true }).parseWithErrors(input)

    for (const [name, result] of [
      ['interpreter', interpreter],
      ['exec.ts', reference],
      ['tableRules', assembled],
      ['compile()', compiled],
    ] as const) {
      expect(result.ok, name).toBe(true)
      expect(result.errors, name).toHaveLength(1)
      expect(result.errors[0]!.span, name).toEqual(expectedSpan)
      if (!result.ok) throw new Error(`${name} unexpectedly failed`)
      expect((result.value as unknown[])[1], `${name}: embedded error`)
        .toMatchObject({ _tag: 'parseError', span: expectedSpan, expected: ['x'] })
    }
  })
})
