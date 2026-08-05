import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeTable, UnsupportedConstruct } from '../../src/table/encode.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { compose } from '../../src/compiler/linker.ts'
import { baseNodes, dispatchNoFallback, dispatchNodes, fieldNodes, jsonRules, selectNodes } from '../../bench/table-grammars.ts'
import {
  balanced, choice, keywords, literal, many, node, optional, parser, peek, regex, rules,
  gate, sepBy, sequence, token, transform, trivia, withCtx, type Combinator,
} from '../../src/index.ts'

/**
 * FAIL-CLOSED, one construct at a time.
 *
 * Every refusal in `encode.ts` exists because lowering the construct WRONG
 * produces a table that parses fine and moves only the tree — the failure class
 * no ordinary assertion catches. A refusal that stops firing is therefore
 * indistinguishable from a correct lowering unless something asserts the throw,
 * and until this file nothing did: the `UnsupportedConstruct` class and most of
 * its throw sites were uncovered lines.
 *
 * Each case pairs the refusal with a POSITIVE CONTROL — the same shape without
 * the refused option — so a blanket "encodeTable throws on everything"
 * regression cannot pass this file.
 */

const wrap = (inner: Combinator<unknown>): Record<string, Combinator<unknown>> => ({ Doc: inner })

const throws = (g: Record<string, Combinator<unknown>>, re: RegExp): void => {
  expect(() => encodeTable(g)).toThrow(UnsupportedConstruct)
  expect(() => encodeTable(g)).toThrow(re)
}

describe('encodeTable refuses what it cannot lower faithfully', () => {
  it('transform(recognitionOnly) — a suppressed value is not an inert transform', () => {
    // Set on the def by `scanTo.ts`, which has no public constructor for it.
    // A recognition-only transform SUPPRESSES its value; lowering it as an
    // ordinary transform would produce a value the other two engines do not.
    const suppressed = transform(literal('a'), v => v)
    ;(suppressed._def as { recognitionOnly?: boolean }).recognitionOnly = true
    throws(wrap(suppressed as Combinator<unknown>), /transform\(recognitionOnly\)/)
    expect(() => encodeTable(wrap(transform(literal('a'), v => v) as Combinator<unknown>))).not.toThrow()
  })

  it('choice(greedyClassify) — one arm runs and ANOTHER arm is credited', () => {
    // Auto-detected: one regex arm that subsumes every literal arm. It runs the
    // regex and then re-attributes the match by string equality, re-applying a
    // different arm's transforms. Ordered choice is a different execution, not a
    // different order, so it is refused rather than approximated.
    const g = wrap(choice(regex(/[a-z]+/), literal('if')) as Combinator<unknown>)
    expect((g.Doc!._def as { strategy?: { tag: string } }).strategy?.tag).toBe('greedyClassify')
    throws(g, /greedyClassify/)
    // Control: the same arms with no subsumption lower fine.
    expect(() => encodeTable(wrap(choice(regex(/[0-9]+/), literal('if')) as Combinator<unknown>))).not.toThrow()
  })

  it('choice(gate:) — a per-arm state predicate is a condition with no row', () => {
    const gated = choice({ gate: () => true, combinator: literal('a') } as never, literal('b')) as Combinator<unknown>
    throws(wrap(gated), /choice\(gate:\)/)
    expect(() => encodeTable(wrap(choice(literal('a'), literal('b')) as Combinator<unknown>))).not.toThrow()
  })

  it('node(captureTrivia) — an explicit request the arity cannot express, now HONOURED', () => {
    // The capture flags are derived from the reducer's ARITY, and a 3-argument
    // reducer that ALSO asks for capture is a request the arity analysis answers
    // "no" to. That used to REFUSE. Honouring the arity alone would have parsed
    // perfectly and dropped the trivia, which is the silent-failure this guards.
    //
    // The fix is not to trust the arity: `encode.ts` mirrors `node.ts:215` term
    // for term, so the explicit flag is an OR alongside the derived bit. The bar
    // is that the trivia REACHES THE REDUCER, not that the grammar encodes — a
    // flag set and never read would pass an encode-only assertion.
    const ws = trivia(regex(/[ \t]*/))
    const seen: Record<string, readonly number[]> = {}
    const mk = (tag: string, opts?: { captureTrivia?: true }) =>
      parser({ trivia: ws }, node('N', sequence(literal('a'), literal('b')),
        // arity 5 reaches `triviaLog`; the point is that arity 3 + the flag does too.
        ((c: readonly unknown[], _f: unknown, _s: unknown, _r: unknown, tl: readonly number[]) => {
          seen[tag] = tl.slice()   // COPY: the log is ctx-owned and gets truncated on rollback
          return c
        }) as never, opts as never)) as unknown as Combinator<unknown>

    const withFlag = mk('on', { captureTrivia: true })
    expect(() => encodeTable(wrap(withFlag))).not.toThrow()
    const table = tableRules(encodeTable({ Doc: withFlag })).Doc!
    expect(run(table as never, 'a b').ok).toBe(true)
    const fromTable = seen.on
    delete seen.on
    run(withFlag as never, 'a b')
    const fromInterp = seen.on
    // The interpreter is the reference: the table must capture the SAME log.
    // Both are COPIES taken inside the reducer, so this cannot pass by aliasing.
    expect(fromTable, 'table trivia log').toEqual(fromInterp)
    expect(fromTable!.length, 'the run between "a" and "b" was captured').toBeGreaterThan(0)
  })

  it('parser({ captureTrivia }) — lowered at the scope, as at the node', () => {
    // The scope form sets `ctx.captureTrivia` for its whole subtree
    // (`grammar.ts:129`). It lowers to OP_SCOPE_CAP — a SEPARATE opcode rather
    // than a flag operand, so the assembler SELECTS the capturing piece instead
    // of testing a config field per scope entry.
    const ws = trivia(regex(/[ \t]*/))
    const mk = (opts: Record<string, unknown>) => {
      const seen: number[][] = []
      const inner = node('N', sequence(literal('a'), literal('b')),
        ((c: readonly unknown[], _f: unknown, _s: unknown, _r: unknown, tl: readonly number[]) => {
          seen.push([...tl]); return c
        }) as never)
      return { g: parser({ trivia: ws, ...opts }, inner) as unknown as Combinator<unknown>, seen }
    }
    const on = mk({ captureTrivia: true })
    expect(() => encodeTable(wrap(on.g))).not.toThrow()
    const table = tableRules(encodeTable({ Doc: on.g })).Doc!
    expect(run(table as never, 'a b').ok).toBe(true)
    const fromTable = on.seen.at(-1)!
    run(on.g as never, 'a b')
    const fromInterp = on.seen.at(-1)!
    // Table must match the interpreter, and must actually have captured the run.
    expect(fromTable, 'scope-level capture').toEqual(fromInterp)
    expect(fromTable.length, 'the run between "a" and "b" was captured').toBeGreaterThan(0)
    // Control: the same scope WITHOUT the flag still lowers.
    const plain = parser({ trivia: ws }, sequence(literal('a'), literal('b'))) as unknown as Combinator<unknown>
    expect(() => encodeTable(wrap(plain))).not.toThrow()
  })

  it('parser({ trackLines: true }) is RECONCILED with the settings, not blanket-refused', () => {
    // The interesting half is that it is ACCEPTED when the table agrees: a scope
    // asking for tracking inside a tracking table is not a disagreement. Refusing
    // it outright broke every `*PositionsGrammar` in the repo.
    const g = rules<Record<string, Combinator<unknown>>>({ trackLines: true }, () => ({
      Doc: node('Doc', literal('a'), (c, _f, span) => ({ c, span })),
    })) as unknown as Record<string, Combinator<unknown>>
    throws(g, /trackLines: true.*trackLines: false/s)
    const ok = encodeTable(g, { trackLines: true })
    expect(ok.lines).toBe(1)
    // …and it really tracks: the span carries line fields, not just `{start,end}`.
    const span = (run(tableRules(ok).Doc! as never, 'a').value as { span: Record<string, number> }).span
    expect(span.startLine).toBe(1)
    expect(span.endColumn).toBe(2)
  })

  it('an unknown combinator tag names ITSELF in the refusal', () => {
    // The message must carry the tag, or a build failure says only that
    // something, somewhere, is unsupported.
    //
    // The tag is SYNTHETIC on purpose. This used to point at `withCtx`, which
    // meant the test broke the moment `withCtx` was lowered — it was asserting
    // "this construct is unsupported" when the thing worth asserting is "the
    // message names whatever the construct was". A real combinator here is a
    // countdown to a false failure.
    const bogus = literal('a')
    const shaped = { ...bogus, _def: { ...bogus._def, tag: 'notACombinator' } } as unknown as Combinator<unknown>
    throws(wrap(shaped), /no opcode for 'notACombinator'/)
  })

  it('gate() + withCtx() lower, and agree with the interpreter on the EXPECTED set', () => {
    // `gate()` carries the def tag `guard` (the rename was API-surface only), so
    // it fell through to the unknown-tag refusal. `withCtx` supplies the state it
    // reads, so the pair is tested together: a lowering that dropped the state
    // would make every gate fail, and one that dropped the predicate would make
    // every gate pass.
    //
    // The expected set is compared, not just the value. `gate()` fails with the
    // literal label 'guard' for parity with the compiled path, and that label is
    // what the identity sweep sees.
    const body = transform(sequence(gate((s: unknown) => (s as { inFn?: boolean })?.inFn === true), literal('r')), () => 'SAW')
    const cases: Record<string, Combinator<unknown>> = {
      inFn: withCtx({ inFn: true }, body) as Combinator<unknown>,
      notInFn: withCtx({ inFn: false }, body) as Combinator<unknown>,
      bare: body as Combinator<unknown>,
    }
    const r = tableRules(encodeTable(cases))
    for (const key of Object.keys(cases)) {
      for (const src of ['r', 'x']) {
        const t = run(r[key]! as never, src)
        const i = run(cases[key]! as never, src)
        expect(t.ok, `${key} ${src}`).toBe(i.ok)
        expect(t.value, `${key} ${src}`).toEqual(i.value)
        expect(t.expected, `${key} ${src} expected`).toEqual(i.expected)
      }
    }
    // The predicate really gates: same input, opposite state, opposite outcome.
    expect(run(r.inFn! as never, 'r').ok).toBe(true)
    expect(run(r.notInFn! as never, 'r').ok).toBe(false)
  })

  it('an empty rule map still produces a runnable table', () => {
    // `finish()` emits one OP_EMPTY when nothing was encoded, so `resolveTable`
    // never sees a zero-length code array.
    const prog = encodeTable({})
    expect(prog.code.length).toBeGreaterThan(0)
    expect(prog.rules).toEqual({})
    expect(Object.keys(tableRules(prog))).toEqual([])
  })
})

/**
 * The constructs that are not recoverable from `_def` and are therefore carried
 * as their CONSTRUCTOR ARGUMENTS (`OP_SCAN` + `prog.scans`). `balanced()` is the
 * sharp one: it overrides `.parse` and leaves `_def` as the eager interior, so a
 * structural encoding builds a different parser and reports nothing — the spec
 * hands the arguments back to `balanced()` and lets it rebuild itself.
 */
describe('the scanning constructs — carried as specs, and emittable', () => {
  const balancedGrammar = rules<Record<string, Combinator<unknown>>>(() => ({
    Doc: node('Doc', balanced('(', ')'), c => ({ t: 'Doc', c })),
  })) as unknown as Record<string, Combinator<unknown>>

  const tokenGrammar = rules<Record<string, Combinator<unknown>>>(() => ({
    Doc: node('Doc', token(sequence(literal('a'), many(literal('b')))), c => ({ t: 'Doc', c })),
  })) as unknown as Record<string, Combinator<unknown>>

  it('balanced() and token() parse identically to the interpreter through the table', () => {
    for (const [name, g] of [['balanced', balancedGrammar], ['token', tokenGrammar]] as const) {
      const table = tableRules(encodeTable(g)).Doc!
      for (const input of ['(a(b)c)', '(a', 'abb', 'a', '', 'zz']) {
        expect(JSON.stringify(run(table as never, input)), `${name} ${JSON.stringify(input)}`)
          .toBe(JSON.stringify(run(g.Doc! as never, input)))
      }
    }
    // Not vacuous: the balanced scan really consumed the nesting, and `token`
    // really flattened its sequence to one string.
    const b = run(tableRules(encodeTable(balancedGrammar)).Doc! as never, '(a(b)c)').value as { c: Array<{ value: string }> }
    expect(b.c[0]!.value).toBe('(a(b)c)')
    const t = run(tableRules(encodeTable(tokenGrammar)).Doc! as never, 'abb').value as { c: Array<{ value: string }> }
    expect(t.c[0]!.value).toBe('abb')
  })

  it('FIXED: a scanning grammar emits, and its const pool holds no live object', () => {
    // WAS the documented limit: `balanced()` parked a live combinator, the
    // grammar ran in memory and could not ship as a module — which made the
    // lowering's own size claim unmeasurable, since every shipping grammar uses
    // one of these. It is now a `ScanSpec`, and the emitted module round-trips
    // (test/unit/table-emit-roundtrip.test.ts).
    const prog = encodeTable(balancedGrammar)
    expect(prog.runtimeOnly).toBeUndefined()
    expect(emitTableModule(prog)).toContain('sc:[')
    // The const pool is the thing that used to hold the combinator. Nothing in it
    // may be an object other than a RegExp or an array of primitives — that is
    // what `emitConst` enforces, asserted here on a program that once failed it.
    for (const v of prog.k) {
      expect(typeof v === 'object' && v !== null && !(v instanceof RegExp) && !Array.isArray(v), String(v)).toBe(false)
    }
    expect(encodeTable(tokenGrammar).runtimeOnly).toBeUndefined()
    expect(() => emitTableModule(encodeTable(tokenGrammar))).not.toThrow()
  })
})

describe('trivia scopes are table rows, not lowering decisions', () => {
  const outerWs = trivia(regex(/[ \t]*/))
  const dots = trivia(regex(/\.*/))
  const opts = { trivia: outerWs as never }

  const g = rules<Record<string, Combinator<unknown>>>({ trivia: outerWs }, () => ({
    Loose: node('Loose', sequence(literal('a'), literal('b')), c => ({ t: 'Loose', c })),
    // `trivia: null` clears it for the subtree; a different trivia REPLACES it.
    Tight: node('Tight', parser({ trivia: null }, sequence(literal('a'), literal('b'))) as unknown as Combinator<unknown>, c => ({ t: 'Tight', c })),
    Dotted: node('Dotted', parser({ trivia: dots }, sequence(literal('a'), literal('b'))) as unknown as Combinator<unknown>, c => ({ t: 'Dotted', c })),
  })) as unknown as Record<string, Combinator<unknown>>

  it('a cleared scope stops skipping, and a replaced scope skips the OTHER thing', () => {
    const t = tableRules(encodeTable(g))
    // One input, three scopes — the difference IS the scope row.
    expect(run(t.Loose! as never, 'a b', opts).ok).toBe(true)
    expect(run(t.Tight! as never, 'a b', opts).ok).toBe(false)
    expect(run(t.Tight! as never, 'ab', opts).ok).toBe(true)
    expect(run(t.Dotted! as never, 'a..b', opts).ok).toBe(true)
    expect(run(t.Dotted! as never, 'a b', opts).ok).toBe(false)
    // …and every one of those matches the interpreter.
    for (const [rule, input] of [['Loose', 'a b'], ['Tight', 'a b'], ['Tight', 'ab'], ['Dotted', 'a..b'], ['Dotted', 'a b']] as const) {
      expect(run(t[rule]! as never, input, opts).ok, `${rule} ${JSON.stringify(input)}`)
        .toBe(run(g[rule]! as never, input, opts).ok)
    }
  })
})

describe('terminals the table REBUILDS rather than references', () => {
  it('keywords() becomes ONE regex that keeps the boundary and the folding', () => {
    // The encoder rebuilds the alternation instead of reusing the combinator's.
    // A rebuild that dropped the boundary would match the prefix of a longer word
    // and still look like a successful parse.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Kw: node('Kw', keywords(['if', 'ifdef'], { boundary: 'a-z' }), c => ({ t: 'Kw', c })),
      Ci: node('Ci', keywords(['red', 'blue'], { caseInsensitive: true }), c => ({ t: 'Ci', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g))
    const value = (rule: string, input: string): string =>
      (run(t[rule]! as never, input).value as { c: Array<{ value: string }> }).c[0]!.value
    // Longest-first, and the boundary refusing a longer word.
    expect(value('Kw', 'ifdef')).toBe('ifdef')
    expect(value('Kw', 'if')).toBe('if')
    expect(run(t.Kw! as never, 'iffy').ok).toBe(false)
    expect(run(t.Kw! as never, 'ifx').ok).toBe(false)
    // Case-insensitive keeps the INPUT's casing, not the keyword's.
    expect(value('Ci', 'RED')).toBe('RED')
    expect(run(t.Ci! as never, 'green').ok).toBe(false)
    // Accept/reject and value agree with the interpreter on every case.
    for (const [rule, input] of [['Kw', 'if'], ['Kw', 'ifdef'], ['Kw', 'iffy'], ['Ci', 'RED'], ['Ci', 'Blue'], ['Ci', 'green']] as const) {
      const a = run(t[rule]! as never, input)
      const b = run(g[rule]! as never, input)
      expect(a.ok, `${rule} ${input}`).toBe(b.ok)
      expect(JSON.stringify(a.value), `${rule} ${input}`).toBe(JSON.stringify(b.value))
    }
  })

  it('a case-insensitive literal yields the INPUT casing, tracked or not', () => {
    // OP_LIT_CI returns `input.slice(...)`, not the literal — normalising here
    // would silently rewrite the author's source text into the tree.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: node('Doc', literal('abc', { caseInsensitive: true }), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const first = (rule: unknown, input: string): string =>
      (run(rule as never, input).value as { c: Array<{ value: string }> }).c[0]!.value
    const plain = tableRules(encodeTable(g)).Doc!
    const tracked = tableRules(encodeTable(g, { trackLines: true })).Doc!
    expect(first(plain, 'AbC')).toBe('AbC')
    expect(first(tracked, 'AbC')).toBe('AbC')
    expect(run(plain as never, 'abd').ok).toBe(false)
    expect(JSON.stringify(run(plain as never, 'ABC').value)).toBe(JSON.stringify(run(g.Doc! as never, 'ABC').value))
  })

  it('a first-set gate over NON-ASCII code points admits and rejects correctly', () => {
    // `classHas` has a separate branch for code points ≥ 128 and `lead` has a
    // surrogate-pair read. An ASCII-only corpus enters neither, and an astral
    // character would be gated out of a rule that plainly matches it.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Emoji: node('Emoji', regex(/[\u{1F600}-\u{1F64F}]+/u), c => ({ t: 'Emoji', c })),
      Accent: node('Accent', regex(/[à-ÿ]+/), c => ({ t: 'Accent', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g))
    expect(run(t.Emoji! as never, '\u{1F600}\u{1F601}').ok).toBe(true)
    expect(run(t.Emoji! as never, 'a').ok).toBe(false)
    expect(run(t.Accent! as never, 'é').ok).toBe(true)
    expect(run(t.Accent! as never, 'e').ok).toBe(false)
    for (const [rule, input] of [['Emoji', '\u{1F600}'], ['Emoji', 'x'], ['Accent', 'é'], ['Accent', 'e']] as const) {
      expect(JSON.stringify(run(t[rule]! as never, input)), `${rule} ${input}`)
        .toBe(JSON.stringify(run(g[rule]! as never, input)))
    }
  })

  it('optional() yields NULL on a miss, through the table as in the interpreter', () => {
    // It yielded `undefined` here once. Both serialise away, so the bug survived
    // a digest comparison and was found only by reading the value back.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: transform(sequence(literal('a'), optional(literal('b'))), v => (v as unknown[])[1]) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    expect(run(t as never, 'a').value).toBeNull()
    expect(run(t as never, 'a').value).not.toBeUndefined()
    expect(run(t as never, 'ab').value).toBe('b')
  })
})

/**
 * FAILURE REPORTING — the half the three-way identity gate cannot see.
 *
 * `bench/table-lowering-identity.ts` digests `{ ok, value, unconsumedFrom }`. The `expected`
 * set is not in the digest, so a table that accepts and rejects exactly the right
 * inputs while reporting a different error passes the whole sweep. These compare
 * the reported sets directly, against BOTH shipped engines.
 */
describe('table failure reporting matches the interpreter and the compiled path', () => {
  const suites = [
    ['base', baseNodes, 'List', ['(a,b', '(', '(,)', 'zz']],
    ['field', fieldNodes, 'Entry', ['[ab=1', '[', 'zz', '[ab=zz]']],
    ['select', selectNodes, 'Proj', ['ax', '', '###']],
    ['dispatch', dispatchNodes, 'Doc', ['nope', '']],
    ['dispatch-no-fallback', dispatchNoFallback, 'Doc', ['@nope', 'x']],
  ] as const

  it('every failing input reports the same expected set on all three paths', () => {
    for (const [name, g, rule, inputs] of suites) {
      const table = tableRules(encodeTable(g as never))[rule]!
      const compiled = (compose([g as never]) as unknown as Record<string, unknown>)[rule]!
      for (const input of inputs) {
        const t = run(table as never, input)
        const i = run((g as Record<string, unknown>)[rule] as never, input)
        const c = run(compiled as never, input)
        expect(t.ok, `${name} ${JSON.stringify(input)}`).toBe(false)
        expect(t.expected, `${name} ${JSON.stringify(input)} vs interpreter`).toEqual(i.expected)
        expect(t.expected, `${name} ${JSON.stringify(input)} vs compiled`).toEqual(c.expected)
        expect(t.span, `${name} ${JSON.stringify(input)} span`).toEqual(i.span)
        expect(t.expected.length).toBeGreaterThan(0)
      }
    }
  })

  it('TWO shapes still report a different expected set; the dispatch miss and the sepBy min do not', () => {
    // All four accept and reject exactly the right inputs, so the identity sweep
    // is blind to every one of them; only the error message moves. Collected here
    // so the size of the divergence is one number rather than a rumour.
    //
    // Characterised, not endorsed: each `toEqual` on the TABLE row is the current
    // behaviour, and each `interp`/`compiled` row is what it should be.
    //
    // WAS FOUR, THEN THREE. The dispatched-choice miss went first — a choice now
    // carries its own expected set and reports the union on every failing exit.
    // `Min` is the second to go: a list ending under `min` now reports the ITEM,
    // which is what `failAt` (repeat.ts) and codegen's `deriveExpectedArr([item])`
    // both already reported. Both are kept in the grammar so the shapes are still
    // encoded and exercised, and `Min` is asserted POSITIVELY below rather than
    // deleted, so a regression cannot quietly restore the separator.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      // 1. keywords(): the encoder rebuilds the terminal and derives the set from
      //    the rebuilt regex's parts instead of the combinator's own label.
      Kw: node('Kw', keywords(['if', 'ifdef'], { boundary: 'a-z' }), c => ({ t: 'Kw', c })),
      // 2. peek(): the lookahead's INNER expectation escapes.
      Peek: transform(sequence(peek(literal('ab')), literal('a')), v => (v as unknown[])[1]) as Combinator<unknown>,
      // 3. FIXED — a dispatched choice that matches no arm now reports the union.
      //    Kept in the grammar so the shape is still encoded and exercised.
      Ch: choice(
        transform(regex(/[à-ÿ]+/), v => v),
        transform(regex(/[\u{1F600}-\u{1F64F}]+/u), v => v),
        transform(regex(/[0-9]+/), v => v),
      ) as Combinator<unknown>,
      // 4. FIXED — a sepBy that fails its `min` now reports the ITEM, not the
      //    separator. Kept in the grammar so the shape is still encoded.
      Min: sepBy(regex(/[a-z]/), literal(','), { min: 2 }) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g))
    const c = compose([g as never]) as unknown as Record<string, unknown>
    const cases = [
      ['Kw', 'ifx', ['"ifdef"', '"if"'], ['keyword']],
      ['Peek', 'ax', ['"ab"'], ['peek(literal)']],
    ] as const
    for (const [rule, input, fromTable, fromEngines] of cases) {
      expect(run(t[rule]! as never, input).ok, `${rule} ${input}`).toBe(false)
      expect(run(t[rule]! as never, input).expected, `${rule} table`).toEqual(fromTable)
      expect(run(g[rule]! as never, input).expected, `${rule} interpreter`).toEqual(fromEngines)
      expect(run(c[rule] as never, input).expected, `${rule} compiled`).toEqual(fromEngines)
    }
    // `Min`, positively: all THREE now name the item. A list stuck under `min` is
    // stuck wanting another ITEM, and says so wherever it runs.
    for (const engine of [t.Min!, g.Min!, c.Min]) {
      expect(run(engine as never, 'a').ok).toBe(false)
      expect(run(engine as never, 'a').expected).toEqual(['/[a-z]/'])
    }
    // THE FAILURE POSITION NO LONGER MOVES. It did: for '[1,2,]' the table
    // stopped at offset 4 naming one token while both engines reported offset 0
    // and seven. The choice fix corrected the position AND the count; what is
    // left is a single ELEMENT of the seven.
    //
    // Both engines report at the furthest position the enclosing sequence could
    // also have closed at, so they name the CLOSER (`"]"` / `"}"`) in place of
    // one of the value choice's own openers. That is furthest-failure merging,
    // and it is the whole of the residue — pinned at exactly that width so a
    // wider regression cannot hide inside a vague "expected sets differ".
    const jt = tableRules(encodeTable(jsonRules as never)).Value!
    const jc = (compose([jsonRules as never]) as unknown as Record<string, unknown>).Value!
    for (const [bad, engineOnly, tableOnly] of [['[1,2,]', '"]"', '"["'], ['{"a":', '"}"', '"{"']] as const) {
      const fromTable = run(jt as never, bad)
      const fromInterp = run(jsonRules.Value! as never, bad)
      const fromCompiled = run(jc as never, bad)
      // Position and count agree across all three.
      expect(fromTable.span, bad).toEqual({ start: 0, end: 0 })
      expect(fromInterp.span, bad).toEqual({ start: 0, end: 0 })
      expect(fromCompiled.span, bad).toEqual({ start: 0, end: 0 })
      expect(fromTable.expected, bad).toHaveLength(fromInterp.expected.length)
      // The residue is one element, and it is exactly the closer-for-opener swap.
      const tSet = new Set(fromTable.expected)
      const iSet = new Set(fromInterp.expected)
      expect([...iSet].filter(x => !tSet.has(x)), `${bad}: engines-only`).toEqual([engineOnly])
      expect([...tSet].filter(x => !iSet.has(x)), `${bad}: table-only`).toEqual([tableOnly])
    }
    // All three still REJECT — only one element of the report differs.
    for (const bad of ['[1,2,]', '{"a":']) {
      for (const r of [run(jt as never, bad), run(jsonRules.Value! as never, bad), run(jc as never, bad)]) {
        expect(r.ok, bad).toBe(false)
      }
    }

    // FIXED — the dispatched choice used to report ONE arm of three, a set left
    // over from the last attempt rather than the arms it could have taken. It
    // now reports all three, matching both engines. Flipped to a positive
    // three-way assertion rather than deleted, so the shape keeps its coverage.
    const chTable = run(t.Ch! as never, 'a').expected
    const chInterp = run(g.Ch! as never, 'a').expected
    expect(run(c.Ch as never, 'a').expected).toEqual(chInterp)
    expect(chInterp).toHaveLength(3)
    expect([...chTable].sort()).toEqual([...chInterp].sort())
  })

})

/**
 * `scanSkip` REACHES THE EMITTED MODULE, as data.
 *
 * It used to be baked onto the program as LIVE combinators — a table entry is a
 * function, so `run()` will not install it — while `emitTableModule` wrote no
 * `scanSkip` field at all and `runtimeOnly` did not name it. A module emitted
 * from such a program would have parsed with an EMPTY skip list, silently
 * changing what `scanTo`/`balanced` scan over. That was sound only because both
 * readers were themselves emit-blocked; they no longer are, so the set is
 * encoded as subtree references and emitted per rule.
 */
describe('grammar-level scanSkip reaches an emitted module as data', () => {
  const skipStr = token(sequence(literal('"'), regex(/[^"]*/), literal('"')))

  it('a scanSkip grammar emits its set as SUBTREE REFERENCES, per rule', () => {
    const g = rules<Record<string, Combinator<unknown>>>({ scanSkip: [skipStr as Combinator<unknown>] }, () => ({
      Doc: balanced('(', ')') as unknown as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g)
    expect(prog.scanSkip, 'one pooled set').toHaveLength(1)
    expect(prog.scanSkip![0]).toHaveLength(1)
    expect(prog.scanSkipOf, 'the one rule installs set 0').toEqual([0])
    const src = emitTableModule(prog)
    expect(src).toContain('ss:[')
    expect(src).toContain('so:[0]')
    // The reference points at a REAL row, and carries the unit's first set —
    // `balanced()` reads it to decide whether its content run can be bounded.
    const [ip, cls] = prog.scanSkip![0]![0]!
    expect(ip).toBeGreaterThanOrEqual(0)
    expect(ip).toBeLessThan(prog.code.length)
    expect(cls, 'a quoted-string unit starts with exactly one character').toBeGreaterThanOrEqual(0)
    expect(prog.cc[cls]).toBe('""')
  })

  it('the only readers of ctx.scanSkip are the constructs encode refuses', () => {
    // Still load-bearing, for a different reason: `ctx.scanSkip` now holds
    // subtree-backed combinators built by the driver, so a new reader outside
    // `scanTo.ts` would be reading table-internal objects. See the field's
    // comment in program.ts.
    const root = path.join(import.meta.dirname, '../../src')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])
    // CODE lines only — the field is discussed in several comments, including
    // the one this test is named in, and a comment cannot read anything.
    const isCode = (l: string): boolean => !/^\s*(\/\/|\/?\*)/.test(l)
    const readers = walk(root)
      .filter(f => readFileSync(f, 'utf8').split('\n').some(l => isCode(l) && l.includes('ctx.scanSkip')))
      .map(f => path.relative(root, f)).sort()
    // `scanTo.ts` is the only READER. Everything else here WRITES it — the three
    // parse entries install the grammar's ambient set. `run.ts` and `grammar.ts`
    // joined the list without gaining a read: they used to install it with a
    // conditional spread (`...(scanSkip !== undefined ? { scanSkip } : {})`),
    // which this census could not see because the key was a literal rather than
    // `ctx.scanSkip`. They now assign it as a plain store on the canonical
    // context shape, so the write is finally visible to this test. All four are
    // `table/stamp.ts` replaced `table/exec.ts` here when the closure assembler
    // (`table/assemble.ts`) became the second driver: the rule-map envelope both
    // drivers share is the one place that knows the entry rule, so two copies of
    // the write would have been two places for it to drift. All four are
    // listed so a new file cannot slip in either way.
    expect(readers).toEqual([
      'combinators/grammar.ts',
      'combinators/scanTo.ts',
      'functional/run.ts',
      'table/stamp.ts',
    ])
  })
})
