import { describe, expect, it } from 'vitest'
import { compileTable } from '../../src/table/compile.ts'
import { run } from '../../src/functional/run.ts'
import { csvParser } from '../../examples/csv/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'
import { classifiedTrivia, leaf, literal, node, parser, regex, rules, sequence, transform, trivia } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { EMPTY_ARROW } from '../../bench/empty-reducer.ts'
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

  it('HONOURS { coverage: true } — it used to throw, and now it counts', () => {
    // WAS A REFUSAL, and the refusal was right while there was nothing to count:
    // a parser returned with no `coverageDefinitions` reads as a passing run that
    // measured nothing. There are counter rows now (`OP_COV`), so what this pins
    // is the thing the refusal was standing in for — the definitions come back,
    // and they are not empty. The hits themselves are `table-coverage.test.ts`.
    const compiled = compileTable(jsonDoc as Combinator<unknown>, undefined, { coverage: true })
    expect(compiled.coverageDefinitions).toBeDefined()
    expect(compiled.coverageDefinitions!.length).toBeGreaterThan(0)
    // And it is still OFF by default: an ordinary compile carries no denominator,
    // rather than an empty one that divides to a confident 100%.
    expect(compileTable(jsonDoc as Combinator<unknown>).coverageDefinitions).toBeUndefined()
  })
})

/**
 * A table entry must report the SAME trivia metadata the interpreter reports for
 * the combinator it was encoded from.
 *
 * This is the metadata `run()` reads to decide whether `{ rootTrivia: { select } }`
 * is even legal — `triviaKindLabelsFromRunnable` / `rootTriviaClassifiedFromRunnable`
 * in `functional/run.ts`. The encoder used to take it from ONE of the three places
 * a combinator can carry it (`_meta.grammarTrivia`, set by `rules({ trivia }, …)`),
 * so the other two lowered to a table that PARSED correctly and then claimed to
 * have no labelled trivia at all.
 *
 * No value-identity sweep can see this: the tree and the spans are unchanged, and
 * the loss surfaces only as `run()` rejecting a root-trivia request on a grammar
 * that plainly has labelled trivia — or, for `classifiedTrivia()` handed straight
 * to `options.trivia`, silently widening capture, because `triviaKindMask(undefined,
 * …)` means "capture everything".
 */
describe('a table entry carries the trivia metadata run() reads', () => {
  const labels = ['whitespace', 'blockComment']
  const mkTrivia = () => classifiedTrivia({
    whitespace: regex(/[ \t\n\r\f]+/),
    blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })

  /** The `_meta` a table rule function is stamped with, as `run()` sees it. */
  const metaOf = (fn: unknown): {
    triviaKindLabels?: readonly string[]
    rootTriviaClassified?: true
    grammarTrivia?: unknown
  } | undefined =>
    (fn as {
      _meta?: { triviaKindLabels?: readonly string[]; rootTriviaClassified?: true; grammarTrivia?: unknown }
    })._meta

  it('takes them off `parser({ trivia }, …)`, which leaves nothing on _meta', () => {
    // `parser()` stores the trivia on `_def.triviaParser` only — `_meta.grammarTrivia`
    // is undefined here, which is exactly the case the encoder used to miss.
    const doc = parser({ trivia: mkTrivia() }, sequence(regex(/a/), regex(/b/)))
    expect(doc._meta.grammarTrivia).toBeUndefined()

    const entry = assembledRules(encodeTable({ Doc: doc }))['Doc']
    expect(metaOf(entry)?.triviaKindLabels).toEqual(labels)
    expect(metaOf(entry)?.rootTriviaClassified).toBe(true)
  })

  it("takes them off the combinator's own _meta, for a bare classifiedTrivia() root", () => {
    // This is what `options.trivia` is handed as. It is a transparent `trivia`
    // wrapper, so it contributes no row of its own and used to reach the stamp
    // with nothing at all.
    const rw = mkTrivia()
    const entry = assembledRules(encodeTable({ Trivia: rw }))['Trivia']
    expect(metaOf(entry)?.triviaKindLabels).toEqual(labels)
    expect(metaOf(entry)?.rootTriviaClassified).toBe(true)
  })

  it('still takes them off `rules({ trivia }, …)` ambient trivia', () => {
    // The one carrier that already worked — pinned so the added lookups are a
    // widening, not a replacement.
    const g = rules({ trivia: mkTrivia() }, () => ({
      Doc: sequence(regex(/a/), regex(/b/)),
    }))
    expect(g['Doc']!._meta.grammarTrivia).toBeDefined()
    const entry = assembledRules(encodeTable({ Doc: g['Doc']! }))['Doc']
    expect(metaOf(entry)?.triviaKindLabels).toEqual(labels)
    expect(metaOf(entry)?.rootTriviaClassified).toBe(true)
  })

  it('leaves an unlabelled grammar with no LABEL metadata to report', () => {
    const doc = parser({ trivia: trivia(regex(/\s+/)) }, regex(/a/))
    const meta = metaOf(assembledRules(encodeTable({ Doc: doc }))['Doc'])
    expect(meta?.triviaKindLabels).toBeUndefined()
    expect(meta?.rootTriviaClassified).toBeUndefined()
    // The trivia ITSELF is still stamped, labels or not: `run()` consumes the
    // document root's trailing trivia off `_meta.grammarTrivia`, and an entry
    // that withheld it would leave a table parse short of the interpreter's
    // `span` / `unconsumedFrom` on any file ending in whitespace.
    expect(meta?.grammarTrivia).toBeDefined()
  })
})

/**
 * A PRINTED MODULE CAN NEVER CONTAIN AN EMPTY REDUCER.
 *
 * This is the invariant, not the incident. `compileTable` used to call
 * `encodeTable`, which drops the encoder's `fnSrcs` side-channel, so every author
 * callback reached `emitTable*` with no source and the emitters substituted
 * `prog.fns.map(() => '() => {}')`. The result was the worst shape a compiler can
 * produce: a module that loads, parses, reports `ok`, and returns `undefined`
 * where both other engines return a tree. Nothing failed. Nothing warned.
 *
 * The repo has now found this class three times — `parseWithErrors` with an empty
 * `errors` array, a coverage flag that measured nothing, and this. So the fix is
 * pinned as a PROPERTY over the printed text rather than as a case: for any
 * grammar that has reducers at all, no printed artifact may contain an empty
 * arrow in its fn pool. A lowering that cannot source a reducer must REFUSE, by
 * name, through `runtimeOnly`.
 *
 * `EMPTY_ARROW` is imported from `bench/empty-reducer.ts` rather than declared
 * here, because the SIZE gate has to apply the identical property: the stub pool
 * is smaller than real reducer text, so a bytes-only gate reads this defect as an
 * improvement and re-cuts its ceilings against the hollow artifact — which is
 * precisely what happened. Two copies of the pattern would let the correctness
 * half and the size half drift apart, and the size half is the one that failed
 * silently.
 */
describe('a printed table never ships an empty reducer', () => {

  const withReducers: ReadonlyArray<readonly [string, Combinator<unknown>]> = [
    ['json', jsonDoc as Combinator<unknown>],
    ['csv', csvParser as Combinator<unknown>],
    // A root built HERE, at runtime, with no macro anywhere near it — the case
    // that has no captured sources and therefore the one the placeholder hit.
    ['runtime node', node('N', sequence(literal('a'), literal('b')), children => children.length) as Combinator<unknown>],
    ['runtime transform', transform(sequence(literal('a'), literal('b')), parts => parts.join('')) as Combinator<unknown>],
    ['runtime leaf', leaf(regex(/[0-9]+/), text => Number(text)) as Combinator<unknown>],
  ]

  for (const [name, root] of withReducers) {
    it(`${name}: prints real reducer text, or refuses BY NAME`, () => {
      const compiled = compileTable(root)
      const reasons = compiled.runtimeOnly ?? []
      if (compiled.inlineExpression === null) {
        // Refusal is a legal outcome. A SILENT one is not.
        expect(reasons.length, `${name} refused without saying why`).toBeGreaterThan(0)
        expect(compiled.source, `${name} refused, so there is nothing to print`).toBe('')
        return
      }
      expect(reasons, name).toEqual([])
      expect(compiled.source, `${name} module`).not.toMatch(EMPTY_ARROW)
      expect(compiled.inlineExpression, `${name} expression`).not.toMatch(EMPTY_ARROW)
    })
  }

  it('the runtime node actually RETURNS ITS VALUE — the symptom, pinned', () => {
    // `{ ok: true }` with no `value` was the whole defect. It is asserted against
    // the interpreter rather than against `2`, so the case cannot drift into
    // agreeing with a rewritten expectation.
    const root = node('N', sequence(literal('a'), literal('b')), children => children.length)
    const t = compileTable(root as Combinator<unknown>).parse('ab')
    const i = run(root as never, 'ab')
    expect(t.ok).toBe(true)
    expect(i.ok).toBe(true)
    if (t.ok && i.ok) expect(t.value).toEqual(i.value)
  })
})
