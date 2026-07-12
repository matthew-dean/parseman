/**
 * Macro-compilation parity for the three context-sensitive combinators the
 * static evaluator historically could not compile:
 *   - gated `choice` arms       `{ gate, combinator }`
 *   - `guard(pred)`
 *   - `withCtx(extra, inner)`
 *
 * The harness runs the ACTUAL macro-emitted source (transformMacro → eval) and
 * compares its accept/reject + value against the interpreter over both matching
 * and mismatching inputs. The evaluator used to SILENTLY drop a gated arm's
 * predicate (compiling the arm unconditionally), so a macro grammar accepted
 * input the interpreter rejected — the miscompile these tests pin down.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, choice, sequence, parse,
  guard, withCtx,
} from '../../src/index.ts'
import type { GatedArm } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

// Compile a single-binding macro grammar and eval the emitted parser fn.
// Returns { fn, code, warnings }. `fn(input, 0, ctx)` yields a ParseResult.
function macroParser(imports: string, decls: string, varName: string) {
  const full = `import { ${imports} } from 'parseman' with { type: 'macro' }\n${decls}`
  const out = transformMacro(full, 'test.ts', new Set(['parseman']))
  if (!out) throw new Error('transformMacro returned null')
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${out.code}\nreturn ${varName}`)() as
    (input: string, pos: number, ctx: unknown) => { ok: boolean; value?: unknown; span: { start: number; end: number } }
  return { fn, code: out.code, warnings: out.warnings }
}

describe('macro — gated choice arm (Part A safety: no silent gate drop)', () => {
  it('macro-compiled gated choice REJECTS top-level when gate is false (interpreter parity)', () => {
    const entry = choice(
      { gate: (s) => !!(s as { inner?: boolean } | undefined)?.inner, combinator: literal('&') } satisfies GatedArm<string>,
      literal('x'),
    )
    // Interpreter: no ctx.state → gate false → '&' arm skipped → 'x' fails → REJECT
    expect(parse(entry, '&').ok).toBe(false)

    const { fn } = macroParser(
      'literal, choice',
      `const entry = choice(
        { gate: (s) => !!(s && s.inner), combinator: literal('&') },
        literal('x'),
      )`,
      'entry',
    )
    // With no state on ctx, the gate must block the '&' arm — same as interpreter.
    expect(fn('&', 0, {}).ok).toBe(false)
    // And 'x' still parses.
    expect(fn('x', 0, {}).ok).toBe(true)
  })

  it('macro-compiled gated choice ACCEPTS the gated arm when gate is true', () => {
    const { fn } = macroParser(
      'literal, choice',
      `const entry = choice(
        { gate: (s) => !!(s && s.inner), combinator: literal('&') },
        literal('x'),
      )`,
      'entry',
    )
    // The emitted gate reads ctx.state — the ParseContext is the fn's 3rd arg.
    const r = fn('&', 0, { state: { inner: true } })
    expect(r.ok).toBe(true)
    expect(r.value).toBe('&')
  })
})

describe('macro — guard()', () => {
  it('guard parity: rejects when predicate false, accepts when true', () => {
    const g = sequence(guard((s) => (s as { on?: boolean } | undefined)?.on === true), literal('a'))
    expect(parse(g, 'a').ok).toBe(false) // no state → guard fails

    const { fn, warnings } = macroParser(
      'literal, sequence, guard',
      `const g = sequence(guard((s) => s && s.on === true), literal('a'))`,
      'g',
    )
    expect(warnings).toEqual([])
    expect(fn('a', 0, {}).ok).toBe(false)  // no state → guard fails
    expect(fn('a', 0, { state: { on: true } }).ok).toBe(true)
  })
})

describe('macro — withCtx()', () => {
  it('withCtx parity: sets state seen by an inner guard', () => {
    const inner = withCtx({ on: true }, sequence(guard((s) => (s as { on?: boolean }).on === true), literal('a')))
    expect(parse(inner, 'a').ok).toBe(true)

    const { fn, warnings } = macroParser(
      'literal, sequence, guard, withCtx',
      `const inner = withCtx({ on: true }, sequence(guard((s) => s.on === true), literal('a')))`,
      'inner',
    )
    expect(warnings).toEqual([])
    expect(fn('a', 0, {}).ok).toBe(true)  // withCtx installs { on: true }
  })
})

describe('macro — motivating CSS-nesting case (withCtx + gated & arm)', () => {
  const src = `const nestedEntry = choice(
    { gate: (s) => !!(s && s.inner), combinator: literal('&') },
    literal('x'),
  )
  const topEntry = choice(
    { gate: (s) => !!(s && s.inner), combinator: literal('&') },
    literal('x'),
  )
  const doc = sequence(topEntry, withCtx({ inner: true }, nestedEntry))`

  it('compiles clean (no interpreter-fallback warning) and rejects top-level & but accepts nested &', () => {
    const { fn, warnings, code } = macroParser('literal, choice, sequence, withCtx', src, 'doc')
    expect(warnings).toEqual([])
    expect(code).not.toContain("from 'parseman'")  // import fully removed → fully compiled

    // top-level '&' rejected (no ctx.state), nested '&' accepted (withCtx { inner:true }).
    // 'x&' → topEntry matches 'x', withCtx nested matches '&'. ACCEPT.
    const okNested = fn('x&', 0, {})
    expect(okNested.ok).toBe(true)
    expect(okNested.span.end).toBe(2)

    // '&&' → topEntry sees '&' with NO inner state → gate false → 'x' fails → REJECT whole.
    expect(fn('&&', 0, {}).ok).toBe(false)
  })
})
