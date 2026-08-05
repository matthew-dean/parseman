import { describe, expect, it } from 'vitest'
import { compileTable } from '../../src/table/compile.ts'
import { run } from '../../src/functional/run.ts'
import { csvParser } from '../../examples/csv/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * `compileTable()` — the `CompiledParser` contract over a table artifact.
 *
 * The reported blocker for making the table the default lowering was a signature
 * mismatch: `compile()` takes a ROOT COMBINATOR, `encodeTable()` takes a NAMED
 * RULE MAP, and a bench note said the JSON example had to be rebuilt as a rule
 * map "because the shipped example hides most of them in closure consts".
 *
 * That mismatch is not real. A root is a one-rule map. These use the SHIPPED
 * example exports — not hand-rebuilt rule maps — which is the whole point: if
 * they had to be rewritten to encode, this would not be a drop-in.
 */
describe('compileTable() is a drop-in for the source-lowering compile()', () => {
  // Third element is a GOOD input, fourth a definitely-BAD one. The bad input is
  // stated per grammar rather than derived by truncation: a truncated CSV is
  // still valid CSV, so a derived one would have silently tested nothing.
  const cases: ReadonlyArray<readonly [string, Combinator<unknown>, string, string]> = [
    ['json', jsonDoc as Combinator<unknown>, '{"a":[1,2,{"b":null}],"c":"x"}', '{"a":]'],
    ['csv', csvParser as Combinator<unknown>, 'a,b\n1,2\n', '"unterminated'],
  ]

  it('parses the SHIPPED example roots identically to the interpreter', () => {
    for (const [name, root, input] of cases) {
      const compiled = compileTable(root)
      const t = compiled.parse(input)
      const i = run(root as never, input)
      expect(t.ok, name).toBe(true)
      expect(i.ok, name).toBe(true)
      if (t.ok && i.ok) expect(t.value, name).toEqual(i.value)
    }
  })

  /**
   * OPEN DIVERGENCE — see the assertions below for exactly what IS verified.
   *
   * On `{"a":]` the two table drivers agree with each other and both disagree
   * with the interpreter: the table reports the value-start set at the real
   * failure point, the interpreter reports `'"}"'`. This is NOT an assembler
   * bug — `exec` and `assembled` are byte-identical here — and not an artifact
   * of wrapping a root as a one-rule map.
   *
   * It went unseen because the identity suites use the hand-built rule maps in
   * `bench/table-grammars.ts`, never a SHIPPED example root, and because
   * `expected` is not in the identity digest at all.
   *
   * Which engine is right is not settled, so nothing here asserts one. What is
   * asserted is what is known: both engines FAIL on the same input, and the two
   * table drivers agree. Asserting a set that has not been adjudicated would
   * pin whichever answer happened to be current.
   */
  it('fails where the interpreter fails, and the two drivers agree', () => {
    // Failure reporting is the half the identity sweep cannot see: `expected` is
    // not in its digest, so a lowering that accepts and rejects exactly the right
    // inputs while reporting a different error passes the entire sweep. Three
    // such divergences were found in this codebase by comparing sets directly.
    // CSV is excluded because it is TOTAL — verified: it accepts `""`, a bare
    // NUL, an unterminated quote and an unclosed row. There is no failing input
    // to compare, so listing one would have tested nothing.
    for (const [name, root, , bad] of cases.filter(c => c[0] !== 'csv')) {
      const compiled = compileTable(root)
      const t = compiled.parse(bad)
      const i = run(root as never, bad)
      expect(t.ok, `${name} must actually fail`).toBe(false)
      expect(i.ok, `${name} must actually fail`).toBe(false)
      // `expect` does not narrow, so branch for the type as well as the fact.
      if (!t.ok) expect(t.expected.length, `${name} reports something`).toBeGreaterThan(0)
    }
  })

  it('emits BOTH artifacts — a module and an expression', () => {
    const compiled = compileTable(jsonDoc as Combinator<unknown>)
    // The module imports the shared driver; that import is why the artifact is
    // 0.56 MB rather than source lowering's 2.10 MB, and it is not a new
    // dependency — it resolves to `parseman/table`, which a consumer calling
    // `run()` already has.
    expect(compiled.source).toContain('tableRules')
    expect(compiled.source).toContain('import')
    // The expression references the driver by name and carries no import of its
    // own, for an inliner splicing it into existing source.
    expect(compiled.inlineExpression).not.toBeNull()
    expect(compiled.inlineExpression!).toContain('tableRules')
    expect(compiled.inlineExpression!.startsWith('import')).toBe(false)
  })

  it('THROWS on { coverage: true } rather than silently dropping it', () => {
    // A parser returned with no `coverageDefinitions` would read as a passing
    // run that measured nothing. The build error names the reason instead.
    expect(() => compileTable(jsonDoc as Combinator<unknown>, undefined, { coverage: true }))
      .toThrow(/coverage/)
  })
})
