/**
 * THE `Function` CONSTRUCTOR MUST NOT RUN AFTER THE MACRO.
 *
 * Two shipped statements say so, and until this file existed nothing decided
 * either of them:
 *
 *   docs/guide/modes.md      "compile() uses new Function … Use the interpreter
 *                             or the macro build plugin in those environments."
 *   docs/reference/api.md    "With the macro: … No new Function, no eval in the
 *                             emitted code."
 *
 * Both were FALSE. `tableRules(<data>)` is lazy — it triggers nothing — and the
 * FIRST `parse()` builds the emitted assembly with `new Function`
 * (`src/table/assemble.ts`). So a CSP environment without `unsafe-eval` did not
 * get "the macro build plugin" as an escape hatch; it got a silent drop to the
 * closure engine, which is the permanently-slow-and-undiagnosed path the rest of
 * this package refuses to allow anywhere else.
 *
 * ── WHY A COUNTER AND NOT A SOURCE SCAN ─────────────────────────────────────
 *
 * A static scan of the emitted artifact is also run below, and it is NOT
 * sufficient on its own: the artifact never contained the string `new Function`,
 * because the call is in the RUNTIME the artifact imports. A scan of the emitted
 * text is exactly the vacuous instrument `AGENTS.md` describes — clean, plausible
 * and blind to the defect. The counter is the deciding half; the scan is a cheap
 * second net for the day someone inlines a driver.
 *
 * The counter proxies `globalThis.Function`, which is what `new Function(...)`
 * resolves to in every module here, and traps BOTH `construct` and `apply`
 * (`Function(...)` without `new` is the same operation).
 */
import { describe, expect, it } from 'vitest'
import { encodeTable, type TableSettings } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { run } from '../../src/functional/run.ts'
import {
  baseNodes, dispatchNodes, fieldNodes, hostNodes, jsonRules, jsonWs,
  selectNodes, trailingTriviaNodes,
} from '../../bench/table-grammars.ts'
import { cssRules } from '../../examples/css/parser.ts'
import type { Combinator } from '../../src/types.ts'

type RuleMap = Record<string, Combinator<unknown>>

/**
 * Run `body` with `globalThis.Function` proxied, returning every source text the
 * constructor was handed. An empty array is the property.
 */
function functionConstructorCalls(body: () => void): string[] {
  const real: FunctionConstructor = globalThis.Function
  const seen: string[] = []
  const note = (args: readonly unknown[]): void => {
    seen.push(String(args[args.length - 1] ?? '').slice(0, 160))
  }
  const spy = new Proxy(real, {
    construct(target, args, newTarget): object {
      note(args)
      return Reflect.construct(target, args, newTarget) as object
    },
    apply(target, thisArg, args): unknown {
      note(args)
      return Reflect.apply(target, thisArg, args) as unknown
    },
  })
  globalThis.Function = spy
  try {
    body()
  } finally {
    globalThis.Function = real
  }
  return seen
}

/** The shipped macro artifact for one rule map: `tableRules(<data>)`. */
function macroArtifact(map: RuleMap, settings: TableSettings = {}): {
  rules: ReturnType<typeof assembledRules>
  source: string
} {
  const prog = encodeTable(map, settings)
  return { rules: assembledRules(prog), source: emitTableModule(prog) }
}

/**
 * Grammars covered. Every example grammar in this repo that lowers to a table,
 * plus the bench rule maps that exercise nodes, fields, dispatch, host output
 * and trailing trivia — the five shapes the emitter lowers differently.
 */
const CASES: ReadonlyArray<{
  name: string
  map: RuleMap
  entry: string
  input: string
  trivia?: Combinator<unknown>
}> = [
  { name: 'json', map: jsonRules as unknown as RuleMap, entry: 'Value', trivia: jsonWs,
    input: '{"a":{"b":[1,-2.5,1e10,true,false,null,"x"]},"c":[]}' },
  { name: 'css', map: cssRules as unknown as RuleMap, entry: 'Stylesheet',
    input: 'a, b .c > d { color: red; margin: 0 auto } @media screen { x { y: z } }' },
  { name: 'baseNodes', map: baseNodes as unknown as RuleMap, entry: 'Doc', input: 'aaa' },
  { name: 'fieldNodes', map: fieldNodes as unknown as RuleMap, entry: 'Doc', input: 'aaa' },
  { name: 'dispatchNodes', map: dispatchNodes as unknown as RuleMap, entry: 'Doc', input: '@media' },
  { name: 'selectNodes', map: selectNodes as unknown as RuleMap, entry: 'Doc', input: 'abc12x!y' },
  { name: 'hostNodes', map: hostNodes as unknown as RuleMap, entry: 'Doc', input: 'aaa' },
  { name: 'trailingTrivia', map: trailingTriviaNodes as unknown as RuleMap, entry: 'Root', input: 'aaa ' },
]

describe('the macro path never reaches the Function constructor', () => {
  for (const c of CASES) {
    it(`${c.name}: a full parse of a macro-built table constructs no functions`, () => {
      const { rules } = macroArtifact(c.map)
      const entry = rules[c.entry]
      expect(entry, `no rule '${c.entry}'`).toBeDefined()

      // The artifact itself is inert — this is the `tableRules(<data>)` half.
      // It is asserted separately so a failure names WHICH half moved.
      const atBuild = functionConstructorCalls(() => { encodeTable(c.map, {}) })
      expect(atBuild, 'building the table program').toEqual([])

      const atParse = functionConstructorCalls(() => {
        const r = run(entry as never, c.input, c.trivia === undefined ? {} : { trivia: c.trivia as never })
        // READ `ok` WITH `consumed`. A failed parse records the full byte count,
        // so a harness that only checks "did not throw" ranks a 0-byte parse as
        // a pass (AGENTS.md).
        if (!r.ok) throw new Error(`${c.name}: parse failed — expected ${JSON.stringify(r.expected)}`)
      })
      expect(atParse, `Function constructor sources built during the parse:\n${atParse.join('\n---\n')}`)
        .toEqual([])
    })
  }

  it('the emitted module text contains no eval-family construct', () => {
    for (const c of CASES) {
      const { source } = macroArtifact(c.map)
      expect(source, `${c.name}: emitted module`).not.toMatch(/\bnew\s+Function\b/)
      expect(source, `${c.name}: emitted module`).not.toMatch(/\beval\s*\(/)
    }
  })

  it('every option set a parse can select is served without the constructor', () => {
    // The assembly is keyed on five bits, and a table built for one option set
    // is not the table another gets. A property that holds only for the default
    // set is a property that stops holding the first time a consumer passes
    // `tolerant` or a CST host — which is how `tolerant` decides WHICH TABLE is
    // built and made an entire before/after vacuous (AGENTS.md).
    // `trackLines` and `hostMode` are BUILD settings (`TableSettings`), so they
    // vary by artifact; `tolerant` is a per-call option, so it varies within one.
    for (const trackLines of [false, true]) {
      for (const hostMode of ['ast', 'cst'] as const) {
        const { rules } = macroArtifact(jsonRules as unknown as RuleMap, { trackLines, hostMode })
        const entry = rules.Value!
        for (const tolerant of [false, true]) {
          const calls = functionConstructorCalls(() => {
            run(entry as never, '{"a":[1,2,3]}', { trivia: jsonWs as never, tolerant })
          })
          expect(calls, `trackLines=${trackLines} hostMode=${hostMode} tolerant=${tolerant}`).toEqual([])
        }
      }
    }
  })
})
