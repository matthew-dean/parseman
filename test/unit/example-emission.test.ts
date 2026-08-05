import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeTable } from '../../src/table/encode.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { EXAMPLE_SPECS } from '../../bench/size-guard.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * EMISSION SANITY FOR EVERY SHIPPED EXAMPLE GRAMMAR.
 *
 * Nothing asserted that a shipped grammar could be EMITTED. `example/css` and
 * `example/jsonc` sat unprintable — they encoded, they ran, they parsed, and
 * `emitTableModule` refused them — and that surfaced only sideways, as a size
 * fixture reading zero bytes. A grammar that cannot be printed cannot ship as a
 * macro artifact, which is the whole purpose of the table lowering.
 *
 * The four properties gated per grammar:
 *
 *   1. it ENCODES        — `encodeTable` does not throw
 *   2. it PRINTS         — `prog.runtimeOnly` is empty and `emitTableModule`
 *                          returns a module. An empty `source` is a FAILURE here,
 *                          never a skip: that is exactly the state css and jsonc
 *                          were in while every suite was green.
 *   3. it ROUND-TRIPS    — the printed module is written, imported, and parsed
 *                          with, and agrees with the in-memory table
 *   4. it MATCHES the interpreter — on a real input AND on a failing one,
 *                          including `expected`
 *
 * `expected` is compared explicitly because it is a TOP-LEVEL field of
 * `RunResult` and is NOT part of the identity digest the table cutover was
 * checked with — which is how six divergences hid. Comparing only `ok`/`value`
 * would repeat that.
 *
 * SCOPE — shipped grammars, not scaffolding. The bar is "would a user ship this
 * as a macro artifact?". `EXAMPLE_SPECS` (bench/size-guard.ts) is the repo's
 * existing registry of exactly those, so this reuses it rather than growing a
 * second list to forget. Synthetic one-off grammars inside unit tests are NOT
 * covered: they have targeted tests already, and blanket emission assertions on
 * them buy runtime rather than signal.
 *
 * NOT HAND-LISTED — see the STALE sweep at the bottom. Every `.ts` under
 * `examples/` must be either registered (and therefore gated) or carry a named
 * reason for not being a shipped grammar. A new example file fails this test
 * until someone classifies it, which is the property that stops a grammar being
 * added and silently never gated.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DIR, '../..')
const EXAMPLES = path.join(ROOT, 'examples')
const EXEC = pathToFileURL(path.resolve(ROOT, 'src/table/exec.ts')).href

/**
 * Files under `examples/` that are NOT shipped grammars, each with the reason.
 *
 * An OMISSION is what let css and jsonc sit unprintable, so nothing may be
 * absent from both this map and `EXAMPLE_SPECS` — the sweep below fails on
 * anything unaccounted for. Every entry here is a positive statement that the
 * file holds no grammar a user would build an artifact from, not a suppression
 * of a grammar that cannot print. There is currently no example in the second
 * category; if one appears it belongs in `EXAMPLE_SPECS` with the blocking
 * construct named, the way `printable: false` records it in the size baseline.
 */
const NOT_A_SHIPPED_GRAMMAR: Readonly<Record<string, string>> = {
  'css/stub-build.ts': 'CST node constructors used BY examples/css/parser.ts; exports no combinator',
  'lang/ast.ts': 'AST type declarations and constructors; exports no combinator',
  'json/chevrotain-bench.ts': 'benchmark scaffolding — a Chevrotain comparison harness, not a published example',
  'spec-gen.ts': 'a script that prints EBNF and railroad diagrams; exports no combinator',
  'vite.config.ts': 'build configuration for the examples directory',
}

/**
 * Real input per grammar, plus an input it must REJECT.
 *
 * The failing input is not decoration: `expected` and `unconsumedFrom` are only
 * observable on a failure, and they are the fields an identity digest omits.
 */
const INPUTS: Readonly<Record<string, { ok: readonly string[]; bad: readonly string[] }>> = {
  'example/json': { ok: ['{"a":1,"b":[1,2,3],"c":null}', '[]', '12 '], bad: ['{"a":}', '[1,', '@'] },
  'example/csv': { ok: ['name,age\nAlice,30\n', 'a\n'], bad: ['"unterminated'] },
  'example/graphql': { ok: ['{ user { name email } }', 'query Q($x: Int) { f(a: $x) }'], bad: ['{ user {', '###'] },
  'example/css': { ok: ['a { color: red }', '/* c */ .x > .y { a: b; --c: d }', '@media screen { a { b: c } }'], bad: ['a { color: ', '@@@'] },
  'example/lang': { ok: ['1 + 2 * 3', 'if x > 0 then foo(1, 2) else bar'], bad: ['1 +', '(('] },
  'example/jsonc': { ok: ['{ /* c */ "a": 1 } ', '[1, // x\n2]'], bad: ['{ /* unterminated'] },
  'example/jsonl': { ok: ['{"a":1}\n{"b":2}\n', '{"a":1}'], bad: ['{"a":'] },
}

/**
 * The source a real build would have for one reducer.
 *
 * A macro build reads the author's TEXT out of the file it is lowering, so it
 * never meets this: here the only handle on a reducer is the live function, and
 * `String(fn)` of a BUILTIN is `function parseFloat() { [native code] }` — text
 * that is not JavaScript. `examples/graphql/parser.ts` passes `parseFloat`
 * straight through as a reducer, so an unguarded `String(fn)` emits a module
 * that does not parse, and the failure would read as an emission bug rather
 * than as this reconstruction being lossy.
 *
 * A builtin IS its global binding, so emitting the NAME is exact rather than
 * approximate. Anything else claiming `[native code]` has no faithful text and
 * is refused loudly instead of emitted broken.
 */
function reducerSource(fn: unknown): string {
  const src = String(fn)
  if (!src.includes('[native code]')) return src
  const name = (fn as { name?: string }).name ?? ''
  if (name !== '' && (globalThis as unknown as Record<string, unknown>)[name] === fn) return name
  throw new Error(`reducer ${JSON.stringify(name)} is a native function with no printable source`)
}

/**
 * KNOWN, PINNED table-vs-interpreter `expected` divergences — `${id}|${input}`.
 *
 * Not a suppression: both sides are written down, and both are asserted exactly.
 * If either moves, or if the divergence is repaired, this test fails and says so
 * — which is the opposite of the silence that let css and jsonc sit unprintable.
 *
 * THE ONE ENTRY, and why it is recorded here rather than fixed here. A failing
 * `keywords()` reports the CATEGORY, `['keyword']`, not the family's literals
 * (combinators/keywords.ts:137), and `table/encode.ts:505-515` deliberately
 * matches that for the keywords ROW. The CHOICE row a few cases down
 * (`encode.ts:640`) builds its expected set from `deriveExpected`, which recites
 * the literals instead (`combinators/expect.ts:44`) — so a choice OVER a
 * keywords arm reports what the settled decision at `encode.ts:515` says it must
 * not. `graphqlDoc` is `choice(operationDefinition, fragmentDefinition)` over
 * `keywords(['query','mutation','subscription'])` and `kw('fragment')`, so it
 * lands exactly on that seam.
 *
 * The repair belongs in `deriveExpected`, which is shared by BOTH lowerings and
 * by `expect()`; changing it is a semantics change to error reporting across the
 * whole library, and it is not this lane's. Pinned and reported instead.
 */
const EXPECTED_DIVERGENCE: Readonly<Record<string, { interpreter: readonly string[]; table: readonly string[] }>> = {
  'example/graphql|###': {
    interpreter: ['"{"', 'keyword', 'keyword'],
    table: ['"{"', '"subscription"', '"mutation"', '"query"', '"fragment"'],
  },
}

/** The parse facts a consumer can observe, as one comparable string. */
function outcome(rule: unknown, input: string, dropExpected = false): string {
  const r = run(rule as never, input)
  return JSON.stringify({
    ok: r.ok, value: r.value, span: r.span,
    ...(dropExpected ? {} : { expected: r.expected }),
    unconsumedFrom: r.unconsumedFrom,
  })
}

/**
 * The scope a real macro build already has, reconstructed for a STANDALONE module.
 *
 * An example's reducers call module-level helpers (`mk` in `examples/css`), and
 * the macro splices its output INTO the file those helpers live in, so the
 * scope is simply there. A printed module has no such surroundings, so the
 * round-trip supplies them: star-import every sibling `.ts` in the example's own
 * directory and bind their exports. Derived from the directory rather than a
 * per-grammar list, so a new helper module needs no edit here.
 */
function preambleFor(modulePath: string, reserved: readonly string[]): Promise<string> {
  const dir = path.dirname(modulePath)
  const siblings = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f))
  return (async () => {
    const imports: string[] = []
    const names = new Set<string>()
    for (let i = 0; i < siblings.length; i++) {
      const mod = await import(/* @vite-ignore */ pathToFileURL(siblings[i]!).href) as Record<string, unknown>
      imports.push(`import * as __m${i} from ${JSON.stringify(pathToFileURL(siblings[i]!).href)}`)
      for (const key of Object.keys(mod)) if (!reserved.includes(key)) names.add(key)
    }
    if (names.size === 0) return imports.join('\n')
    const merged = siblings.map((_, i) => `__m${i}`).join(', ')
    return `${imports.join('\n')}\nconst { ${[...names].join(', ')} } = Object.assign({}, ${merged})`
  })()
}

describe('every shipped example grammar ENCODES, PRINTS, round-trips, and matches the interpreter', () => {
  for (const spec of EXAMPLE_SPECS) {
    const modulePath = path.resolve(ROOT, spec.source)

    // `precompiled` means the module exports its ARTIFACT and not the combinator
    // it was built from, so there is nothing here to encode. Recorded as a named
    // case rather than dropped from the loop: an omission is the thing this file
    // exists to prevent.
    if (spec.precompiled === true) {
      it(`${spec.id} — exports a precompiled artifact, so there is no combinator to encode`, async () => {
        const mod = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Record<string, unknown>
        const artifact = mod[spec.exportName]
        expect(artifact, `${spec.source} must export ${spec.exportName}`).toBeDefined()
        // It is still an artifact a user ships, so it must at least be a parser.
        expect(typeof (artifact as { parse?: unknown }).parse).toBe('function')
      })
      continue
    }

    it(`${spec.id} — encodes, prints, and the printed module agrees with the table AND the interpreter`, async () => {
      const mod = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as Record<string, unknown>
      const grammar = mod[spec.exportName] as Combinator<unknown> | undefined
      expect(grammar, `${spec.source} must export ${spec.exportName}`).toBeDefined()

      // 1. ENCODES.
      const prog = encodeTable({ Entry: grammar as Combinator<unknown> }, {})

      // 2. PRINTS. The named refusals are asserted as the failure message so a
      //    regression says WHICH construct blocked it, not merely that it did.
      expect([...(prog.runtimeOnly ?? [])], `${spec.id} cannot be printed`).toEqual([])
      const fnSources = prog.fns.map(reducerSource)
      const source = emitTableModule(prog, { name: 'g', runtime: EXEC, fnSources })
      expect(source.length, `${spec.id} emitted an EMPTY module`).toBeGreaterThan(0)
      expect(source).toContain('tableRules(')

      // 3. ROUND-TRIPS — written, imported, parsed with.
      const preamble = await preambleFor(modulePath, ['g', 'tableRules'])
      const dir = mkdtempSync(path.join(tmpdir(), `pm-example-emit-${spec.id.replace(/\W+/g, '-')}-`))
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
      const file = path.join(dir, 'grammar.ts')
      writeFileSync(file, `${preamble}\n${source}`)
      const emitted = (await import(/* @vite-ignore */ pathToFileURL(file).href) as { g: Record<string, unknown> }).g
      const memory = tableRules(prog)

      expect(Object.keys(emitted).sort()).toEqual(Object.keys(memory).sort())

      // 4. MATCHES the interpreter, on inputs it accepts and inputs it rejects.
      const inputs = INPUTS[spec.id]
      expect(inputs, `${spec.id} has no inputs declared in INPUTS`).toBeDefined()
      const all = [...inputs!.ok, ...inputs!.bad]
      for (const input of all) {
        // emitted vs table is ALWAYS compared in full, `expected` included:
        // nothing about printing a table may change what it reports.
        expect(outcome(emitted.Entry, input), `emitted vs table on ${JSON.stringify(input)}`)
          .toBe(outcome(memory.Entry, input))

        const pinned = EXPECTED_DIVERGENCE[`${spec.id}|${input}`]
        expect(outcome(emitted.Entry, input, pinned !== undefined), `emitted vs interpreter on ${JSON.stringify(input)}`)
          .toBe(outcome(grammar as Combinator<unknown>, input, pinned !== undefined))
        if (pinned !== undefined) {
          // …and the divergence itself is asserted on BOTH sides, so it cannot
          // drift, widen, or be quietly repaired without this test saying so.
          expect(run(grammar as never, input).expected, `pinned interpreter expected for ${JSON.stringify(input)}`)
            .toEqual(pinned.interpreter)
          expect(run(emitted.Entry as never, input).expected, `pinned table expected for ${JSON.stringify(input)}`)
            .toEqual(pinned.table)
        }
      }
      // A pinned divergence for an input this grammar no longer runs is a stale
      // record, which reads as a gate that is not there.
      for (const key of Object.keys(EXPECTED_DIVERGENCE)) {
        if (!key.startsWith(`${spec.id}|`)) continue
        expect(all, `stale EXPECTED_DIVERGENCE entry ${key}`).toContain(key.slice(spec.id.length + 1))
      }
      // The agreement must be on a real parse, not three engines agreeing on
      // failure: an `ok` input that does not parse would make the loop vacuous.
      for (const input of inputs!.ok) {
        expect(run(emitted.Entry as never, input).ok, `${spec.id} should accept ${JSON.stringify(input)}`).toBe(true)
      }
      // A malformed input must NOT read as a clean whole-input parse. Stated as
      // "not clean" rather than `ok === false` because several of these grammars
      // legitimately succeed on a PREFIX and report the rest through
      // `unconsumedFrom` — which is itself a field an identity digest omits, so
      // it is exactly what wants asserting. Either way the three engines have
      // already been compared on `expected` and `unconsumedFrom` above; this
      // guards against the whole `bad` set quietly becoming valid input, which
      // would make that comparison vacuous.
      for (const input of inputs!.bad) {
        const r = run(emitted.Entry as never, input)
        expect(
          r.ok === false || r.unconsumedFrom !== undefined,
          `${spec.id} read malformed input ${JSON.stringify(input)} as a clean full parse`,
        ).toBe(true)
      }
    })
  }

  /**
   * STALE — a new example must be classified, not silently ungated.
   *
   * Same reasoning as the size guard's own STALE check: a hand-list that nobody
   * is forced to update is a gate that quietly shrinks. Every `.ts` under
   * `examples/` is either registered in `EXAMPLE_SPECS` (and therefore gated
   * above) or named in `NOT_A_SHIPPED_GRAMMAR` with a reason.
   */
  it('every file under examples/ is either a gated grammar or a named non-grammar', () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap(f => {
      const p = path.join(d, f)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
    const registered = new Set(EXAMPLE_SPECS.map(s => path.relative(EXAMPLES, path.resolve(ROOT, s.source))))
    const declared = new Set(Object.keys(NOT_A_SHIPPED_GRAMMAR))
    const unaccounted = walk(EXAMPLES)
      .map(p => path.relative(EXAMPLES, p))
      .filter(rel => !registered.has(rel) && !declared.has(rel))
    expect(
      unaccounted,
      'new example file(s) are gated by NOTHING. Register the grammar in EXAMPLE_SPECS '
      + '(bench/size-guard.ts) so it is emission- and size-gated, or add it to '
      + 'NOT_A_SHIPPED_GRAMMAR with the reason it holds no shippable grammar.',
    ).toEqual([])

    // …and the reverse: a reason recorded for a file that no longer exists is a
    // stale suppression, which reads as coverage that is not there.
    const present = new Set(walk(EXAMPLES).map(p => path.relative(EXAMPLES, p)))
    expect([...declared].filter(rel => !present.has(rel)), 'stale NOT_A_SHIPPED_GRAMMAR entries').toEqual([])
    expect([...registered].filter(rel => !present.has(rel)), 'stale EXAMPLE_SPECS entries').toEqual([])
  })
})
