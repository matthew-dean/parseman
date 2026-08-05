import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeTable, UnsupportedConstruct } from '../../src/table/encode.ts'
import { emitTableModule } from '../../src/table/emit.ts'
import { tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { compose, cstBuildHost } from '../../src/compiler/linker.ts'
import { checkIdentity } from '../../bench/table-lowering-identity.ts'
import { baseNodes, dispatchNoFallback, dispatchNodes, fieldNodes, jsonRules, selectNodes } from '../../bench/table-grammars.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { opHistogram } from '../../src/table/inspect.ts'
import { resolveTable } from '../../src/table/program.ts'
import { jsonValue as shippedJsonValue } from '../../examples/json/parser.ts'
import {
  adjacent, balanced, choice, classifiedTrivia, keywords, literal, many, node, notAdjacent,
  optional, parser, peek, regex, rules,
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
  it('transform(recognitionOnly) lowers as an ordinary transform — it is a COMPILE-time marker', () => {
    // This refused on the claim that a recognition-only transform "SUPPRESSES
    // its value". It does not: `recognitionOnly` appears in no combinator's
    // runtime path at all — `map.ts`'s transform never reads it. It is a marker
    // for `composeLeaf` eligibility in the LINKER (see the comment at
    // `scanTo.ts:361`) and a source-lowering analysis flag, both compile-time.
    //
    // So the refusal was reasoning about a runtime semantic that does not exist,
    // and the value it feared diverging is simply the fn's own result.
    const suppressed = transform(literal('a'), v => `X:${String(v)}`)
    ;(suppressed._def as { recognitionOnly?: boolean }).recognitionOnly = true
    const g = wrap(suppressed as Combinator<unknown>)
    expect(() => encodeTable(g)).not.toThrow()
    const table = tableRules(encodeTable(g)).Doc!
    for (const src of ['a', 'z']) {
      const t = run(table as never, src)
      const i = run(suppressed as never, src)
      expect(t.ok, src).toBe(i.ok)
      expect(t.value, src).toEqual(i.value)
      expect(t.expected, src).toEqual(i.expected)
    }
    // The transform really ran — an inert lowering would yield the raw literal.
    expect(run(table as never, 'a').value).toBe('X:a')
  })

  it('choice(greedyClassify) lowers, and the LITERAL arm is the one credited', () => {
    // Auto-detected (choice.ts:186-202): one regex arm that subsumes every other
    // arm, all of which are literals. It runs the regex ONCE and re-attributes
    // the match by string equality, running a DIFFERENT arm's transform chain —
    // so this is not an arm ordering, and `OP_CHOICE` cannot express it.
    //
    // THE ARMS PRODUCE DIFFERENT VALUES ON PURPOSE. A greedyClassify test whose
    // arms agree proves nothing: an ordered-choice lowering runs the regex arm
    // first and succeeds, and every assertion still passes. Here the regex arm
    // tags `ident` and the literal arm tags `KEYWORD`, so crediting the wrong
    // arm is visible in the value.
    const g = wrap(choice(
      transform(regex(/[a-z]+/), w => ({ kind: 'ident', w })),
      transform(literal('if'), w => ({ kind: 'KEYWORD', w })),
    ) as Combinator<unknown>)
    expect((g.Doc!._def as { strategy?: { tag: string } }).strategy?.tag).toBe('greedyClassify')

    const r = checkIdentity(g, 'Doc', [
      { name: 'classified', input: 'if' },
      { name: 'regex-wins-longer', input: 'ifx' },
      { name: 'regex-wins-other', input: 'zz' },
      { name: 'no-match', input: '1' },
    ])
    expect(r.mismatches).toEqual([])
    expect(r.matched).toBe(r.total)

    // ARM ATTRIBUTION, stated directly. The regex arm MATCHES 'if' — it is what
    // produced the span — and the literal arm is credited anyway, with its own
    // transform running. An ordered `choice` would answer `ident` here.
    const t = tableRules(encodeTable(g)).Doc!
    expect(run(t as never, 'if').value).toEqual({ kind: 'KEYWORD', w: 'if' })
    expect(run(g.Doc! as never, 'if').value).toEqual({ kind: 'KEYWORD', w: 'if' })
    // One char more and attribution moves back to the regex arm.
    expect(run(t as never, 'ifx').value).toEqual({ kind: 'ident', w: 'ifx' })
    // The super arm's failure propagates VERBATIM — the regex's own expected
    // set, not the union of the arms (choice.ts:126).
    expect(run(t as never, '1').expected).toEqual(run(g.Doc! as never, '1').expected)
    expect(run(t as never, '1').expected).toEqual(['/[a-z]+/'])
  })

  it('greedyClassify contributes ONE cst leaf, whichever arm is credited', () => {
    // The interpreter keeps the leaf the regex arm pushed and merely relabels the
    // VALUE; the table rolls the capture sinks back to the pre-super mark and lets
    // the credited literal arm push its own. Both are one leaf with the same text
    // and span — but only because the classified word IS the arm's literal, so it
    // is asserted rather than assumed. A lowering that skipped the rollback would
    // emit two.
    const g: Record<string, Combinator<unknown>> = {
      Doc: node('Doc', choice(
        transform(regex(/[a-z]+/), w => ({ kind: 'ident', w })),
        transform(literal('if'), w => ({ kind: 'KEYWORD', w })),
      ), () => ({ t: 'Doc' })) as Combinator<unknown>,
    }
    const t = tableRules(encodeTable(g, { hostMode: 'cst' })).Doc!
    for (const src of ['if', 'ifx']) {
      const a = run(t as never, src, { build: cstBuildHost({ tags: true }) as never })
      const b = run(g.Doc! as never, src, { build: cstBuildHost({ tags: true }) as never })
      expect(a.ok, src).toBe(true)
      expect(a.value, src).toEqual(b.value)
      expect((a.value as { children: unknown[] }).children, src).toHaveLength(1)
    }
  })

  it('choice(autoNot) lowers: an arm that MATCHED is rejected and a later arm wins', () => {
    // `autoNot` is computed inside `choice()` (choice.ts:55, 325-346) for a
    // literal arm whenever a LATER arm would have consumed more — a longer
    // literal with this one as a prefix (`startsWith`), or a regex that subsumes
    // it (`firstSet` over the continuation chars). Both kinds run AFTER the arm
    // has succeeded and can still reject it.
    //
    // Both kinds are covered, because they lower to different operands. The
    // third arm in each shape exists only to keep the site off
    // `literalsLongestFirst` / `greedyClassify`, which are different executions.
    const startsWith = wrap(choice(
      transform(literal('if'), () => 'IF'),
      transform(literal('iffy'), () => 'IFFY'),
      transform(sequence(literal('z'), literal('z')), () => 'ZZ'),
    ) as Combinator<unknown>)
    const firstSet = wrap(choice(
      transform(literal('if'), () => 'IF'),
      transform(regex(/[a-z]+/), w => `ID:${String(w)}`),
      transform(regex(/[0-9]+/), w => `NUM:${String(w)}`),
    ) as Combinator<unknown>)

    type Def = { strategy?: { tag: string }; autoNot?: (unknown[] | null)[] }
    expect((startsWith.Doc!._def as Def).strategy?.tag).toBe('firstMatch')
    expect((startsWith.Doc!._def as Def).autoNot![0]).toEqual([{ kind: 'startsWith', value: 'fy' }])
    expect((firstSet.Doc!._def as Def).strategy?.tag).toBe('firstMatch')
    expect((firstSet.Doc!._def as Def).autoNot![0]).toEqual(
      [{ kind: 'firstSet', set: { kind: 'ranges', ranges: [{ lo: 97, hi: 122 }] } }],
    )

    const cases = ['if', 'iff', 'iffy', 'ifx', 'zz', 'q', '12'].map(input => ({ name: input, input }))
    for (const [name, g] of [['startsWith', startsWith], ['firstSet', firstSet]] as const) {
      const r = checkIdentity(g, 'Doc', cases)
      expect(r.mismatches, name).toEqual([])
      expect(r.matched, name).toBe(r.total)
    }

    // POST-SUCCESS REJECTION, stated directly. `literal('if')` MATCHES the first
    // two chars of 'iffy' in both shapes — it is arm zero and it succeeded — and
    // the check fires at its end, so a LATER arm is what the choice returns.
    // Ignoring `autoNot` answers 'IF' to all four of these.
    const ts = tableRules(encodeTable(startsWith)).Doc!
    const tf = tableRules(encodeTable(firstSet)).Doc!
    expect(run(ts as never, 'iffy').value).toBe('IFFY')
    expect(run(tf as never, 'iffy').value).toBe('ID:iffy')
    expect(run(tf as never, 'ifx').value).toBe('ID:ifx')
    // And the check is a LOOKAHEAD, not a blanket veto: with nothing that a later
    // arm could extend into, the arm keeps its win.
    expect(run(ts as never, 'iff').value).toBe('IF')
    expect(run(ts as never, 'if').value).toBe('IF')
    expect(run(tf as never, 'if').value).toBe('IF')
  })

  it('choice(gate:) lowers to OP_ARMGATE — and the gated arm KEEPS its dispatch slot', () => {
    // This refused. The refusal read the option as "a condition with no row",
    // which is true of the predicate and false of the construct: the per-arm gate
    // exists precisely to gate an arm WITHOUT touching its first set, and that is
    // the whole reason it is not `sequence(gate(p), arm)`. `gate()`'s first set is
    // `any` (combinators/gate.ts:26), so leading an arm with one REPLACES that
    // arm's first set and collapses the choice from O(1) first-char dispatch to
    // the ordered loop — `docs/guide/first-char-gating.md` lists that as a known
    // gating defect and names this field as the fix.
    //
    // So a lowering that gates correctly and drops the arm out of dispatch is a
    // silent perf regression that no value assertion can see. `OP_ARMGATE` WRAPS
    // the arm rather than sitting inside it, so `encode.ts` still reads the arm's
    // own first set into `disp` — asserted below on the resolved table, not
    // inferred from the values.
    type S = { on?: boolean }
    const on = (s: unknown): boolean => (s as S | undefined)?.on === true
    const disjointGated = (): Combinator<unknown> => choice(
      { gate: on, combinator: literal('&') } as never,
      literal('x'),
      regex(/[0-9]+/),
    ) as Combinator<unknown>

    // ── DISPATCH SURVIVES ────────────────────────────────────────────────────
    const prog = encodeTable(wrap(disjointGated()))
    expect(Object.keys(opHistogram(prog))).toContain('ARMGATE')
    // `exclusive` IS the O(1) path: `resolveDispatch` sets it only when every
    // arm's class is present and the classes are pairwise disjoint, and both
    // drivers branch on it (exec.ts / assemble.ts `table.exclusive`).
    expect(resolveTable(prog).disp.map(d => d.exclusive)).toEqual([true])
    // The CONTROL that makes that assertion mean something: the same predicate
    // spliced in as a leading `gate()` term instead. Its first set is `any`, so
    // arm 0's class is gone and the site loses dispatch.
    const asLeadingGate = encodeTable(wrap(choice(
      sequence(gate(on), literal('&')),
      literal('x'),
      regex(/[0-9]+/),
    ) as Combinator<unknown>))
    expect(resolveTable(asLeadingGate).disp.map(d => d.exclusive)).toEqual([false])

    // ── THREE-WAY DIFFERENTIAL: interpreter, exec.ts, assemble.ts ────────────
    // The INTERPRETER is the reference in every comparison below. The source
    // lowering used to be a fourth leg; it is gone, and nothing is lost, because
    // it was never the reference — it was a second answer that had to match this
    // one anyway.
    const three = (g: Combinator<unknown>, src: string): [string, string, string] => {
      const p = encodeTable(wrap(g))
      const norm = (o: { ok: boolean; value?: unknown; expected?: readonly string[] }): string =>
        JSON.stringify([o.ok, o.value ?? null, o.expected ?? []])
      return [
        norm(run(g as never, src)),
        norm(run(tableRules(p).Doc! as never, src)),
        norm(run(assembledRules(p).Doc! as never, src)),
      ]
    }
    const allAgree = (g: Combinator<unknown>, src: string): void => {
      const [i, t, a] = three(g, src)
      expect(t, `${src}: exec.ts vs interpreter`).toBe(i)
      expect(a, `${src}: assemble.ts vs interpreter`).toBe(i)
    }

    // gate TRUE — the gated arm is reachable and wins its own first char.
    for (const src of ['&', 'x', '5', 'z']) {
      allAgree(withCtx({ on: true }, disjointGated()) as Combinator<unknown>, src)
    }
    // gate FALSE, and NO STATE AT ALL — `'&'` is rejected, the others untouched.
    for (const src of ['x', '5', 'z']) {
      allAgree(withCtx({ on: false }, disjointGated()) as Combinator<unknown>, src)
      allAgree(disjointGated(), src)
    }
    for (const g of [withCtx({ on: false }, disjointGated()) as Combinator<unknown>, disjointGated()]) {
      for (const engine of three(g, '&')) expect(JSON.parse(engine)[0]).toBe(false)
    }

    // ── THE GATE SKIPS, IT DOES NOT FAIL ─────────────────────────────────────
    // `choice.ts:150` is `continue`, not a failure: with arm 0 gated off, arm 1
    // must be tried at the SAME position and win. The arms are made to disagree
    // on their value on purpose — a lowering that failed the choice, and one that
    // ran arm 0 anyway, are both visible here and neither is visible if the arms
    // agree. Expected sets are compared too: all four report `[]` on a win.
    const skip = (): Combinator<unknown> => choice(
      { gate: on, combinator: transform(literal('aa'), () => 'GATED') } as never,
      transform(regex(/a[a-z]/), () => 'OPEN'),
    ) as Combinator<unknown>
    for (const engine of three(skip(), 'aa')) expect(JSON.parse(engine)).toEqual([true, 'OPEN', []])
    allAgree(skip(), 'aa')
    allAgree(skip(), 'ab')
    for (const engine of three(withCtx({ on: true }, skip()) as Combinator<unknown>, 'aa')) {
      expect(JSON.parse(engine)).toEqual([true, 'GATED', []])
    }

    // ── THE THREE NOW AGREE ON THE FAILING REPORT TOO, NOT ONLY THE VALUE ────
    // A failing DISPATCHED choice names the arm it dispatched to — one arm was
    // attempted, so one arm's set is the answer, and that is the rule the
    // interpreter has always applied (choice.ts:105). The table used to answer
    // with the choice's whole static union here, on the theory that the other
    // engines reached their answer by FURTHEST-FAILURE merging. They do not: no
    // engine merges positionally on the `expected` path. `_fx` already holds the
    // arm's own set when the arm fails, so matching the interpreter is declining
    // to overwrite it (exec.ts, assemble.ts).
    const ungatedControl = choice(literal('ab'), literal('cd')) as Combinator<unknown>
    const [ci, ct, ca] = three(ungatedControl, 'ax')
    expect(JSON.parse(ci)[2], 'ungated: interpreter names the dispatched arm').toEqual(['"ab"'])
    expect(JSON.parse(ct)[2], 'ungated: the table names the dispatched arm too').toEqual(['"ab"'])
    expect(ca, 'ungated: both drivers agree with each other').toBe(ct)
    // A gate-false arm is the same shape: the arm was selected, so its set is the
    // report. OP_ARMGATE writes `deriveExpected(arm)` and nothing overwrites it.
    const [gi, gt, ga] = three(disjointGated(), '&')
    expect(JSON.parse(gi)[2]).toEqual(['"&"'])
    expect(JSON.parse(gt)[2]).toEqual(['"&"'])
    expect(ga).toBe(gt)
    // A dispatch MISS is where the union is right, and all three give it: the
    // interpreter's miss branch runs `parsers.flatMap`, every arm is non-nullable
    // and excluded by this char, so the flatMap's answer IS the static union.
    const [mi, mt, ma] = three(ungatedControl, 'zz')
    expect(JSON.parse(mi)[2], 'miss: the union').toEqual(['"ab"', '"cd"'])
    expect(mt).toBe(mi)
    expect(ma).toBe(mi)
    // EOF IS A MISS, not a reason to leave the disjoint path. Every arm of a
    // disjoint choice is non-nullable, so nothing can match at EOF and the answer
    // is the same union. The interpreter used to fall to firstMatch here, which
    // `continue`s past a gated-off arm and so DROPPED it from the report — the
    // one position where the same gate state gave two different answers, since
    // the in-bounds miss above ignores gates and names it (choice.ts:90).
    const [ei, et, ea] = three(ungatedControl, '')
    expect(JSON.parse(ei)[2], 'eof: the union').toEqual(['"ab"', '"cd"'])
    expect(et).toBe(ei)
    expect(ea).toBe(ei)
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

  it('parser({ trackLines: true }) TURNS THE TABLE ON, with or without the setting', () => {
    // NO LONGER A REFUSAL. This asserted that a tracking scope inside a table
    // built without `TableSettings.trackLines` threw — which made the table
    // lowering reject a grammar the source lowering accepts and annotates: it
    // makes the same decision ONCE for the whole artifact,
    // `opts.trackLines || grammarTrackLines || hasLineTrackingDef(combinator)`.
    // Tracking is a property of the GRAMMAR as much as of the build, so the
    // encoder reads both and the setting only ever adds.
    const g = rules<Record<string, Combinator<unknown>>>({ trackLines: true }, () => ({
      Doc: node('Doc', literal('a'), (c, _f, span) => ({ c, span })),
    })) as unknown as Record<string, Combinator<unknown>>
    for (const prog of [encodeTable(g), encodeTable(g, { trackLines: true })]) {
      expect(prog.lines).toBe(1)
      // …and it really tracks: the span carries line fields, not just `{start,end}`.
      const span = (run(tableRules(prog).Doc! as never, 'a').value as { span: Record<string, number> }).span
      expect(span.startLine).toBe(1)
      expect(span.endColumn).toBe(2)
    }
    // A grammar that asks for nothing still gets nothing.
    const plain = { Doc: node('Doc', literal('a'), (c, _f, span) => ({ c, span })) } as unknown as Record<string, Combinator<unknown>>
    expect(encodeTable(plain).lines).toBe(0)
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

  it('adjacent() / notAdjacent() lower as OP_ADJ and decide the GAP like the interpreter', () => {
    // The assertion is about what sits BETWEEN two terms, so the inputs cover
    // both answers for both polarities and both sides of the kind filter: glued,
    // separated by whitespace, separated by a comment, separated by both. A
    // lowering that ran the test at the POST-trivia-scan position — which is
    // where an ordinary non-first term starts — would report "adjacent"
    // everywhere, making `adjacent()` a no-op and `notAdjacent()` a guaranteed
    // failure. Neither is visible from one polarity alone.
    const classified = (): Combinator<unknown> => classifiedTrivia({
      whitespace: regex(/[ \t\n\r\f]+/),
      comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    }) as Combinator<unknown>
    const glued = (mid: Combinator<null>): Combinator<unknown> =>
      parser({ trivia: classified() }, sequence(literal('a'), mid, literal('b'))) as Combinator<unknown>
    const cases: Record<string, Combinator<unknown>> = {
      Adj: glued(adjacent()),
      NotAdj: glued(notAdjacent()),
      // css-values-4 10.1's constraint: a comment in place of the space does not
      // count, because it vanishes at tokenisation.
      NotAdjWs: glued(notAdjacent({ kinds: ['whitespace'] })),
      NotAdjComment: glued(notAdjacent({ kinds: ['comment'] })),
      // No ambient trivia at all: the gap is empty everywhere, so `adjacent()`
      // is vacuously true and `notAdjacent()` can never hold.
      AdjNoTrivia: sequence(literal('a'), adjacent(), literal('b')) as Combinator<unknown>,
      NotAdjNoTrivia: sequence(literal('a'), notAdjacent(), literal('b')) as Combinator<unknown>,
    }
    const inputs = ['ab', 'a b', 'a   b', 'a/*x*/b', 'a /*x*/b', 'a/*x*/ b', 'a', 'ax', 'b']
    const prog = encodeTable(cases)
    expect(opHistogram(prog).ADJ).toBe(6)
    // BOTH drivers: `exec.ts` is the reference and `assemble.ts` is what ships.
    for (const [driver, r] of [['exec', tableRules(prog)], ['assembled', assembledRules(prog)]] as const) {
      for (const key of Object.keys(cases)) {
        for (const src of inputs) {
          const t = run(r[key]! as never, src)
          const i = run(cases[key]! as never, src)
          const at = `${driver} ${key} ${JSON.stringify(src)}`
          expect(t.ok, at).toBe(i.ok)
          expect(t.value, at).toEqual(i.value)
          expect(t.expected, `${at} expected`).toEqual(i.expected)
        }
      }
    }
    // The assertions really decide, in both directions — a differential against
    // an interpreter that had the same bug would agree on everything.
    const r = assembledRules(prog)
    const ok = (key: string, src: string): boolean => run(r[key]! as never, src).ok
    expect([ok('Adj', 'ab'), ok('Adj', 'a b')]).toEqual([true, false])
    expect([ok('NotAdj', 'ab'), ok('NotAdj', 'a b'), ok('NotAdj', 'a/*x*/b')]).toEqual([false, true, true])
    expect([ok('NotAdjWs', 'a b'), ok('NotAdjWs', 'a/*x*/b')]).toEqual([true, false])
    expect([ok('NotAdjComment', 'a b'), ok('NotAdjComment', 'a/*x*/b')]).toEqual([false, true])
    expect([ok('AdjNoTrivia', 'ab'), ok('NotAdjNoTrivia', 'ab')]).toEqual([true, false])
    // The failure label is the interpreter's, verbatim — the kind filter is
    // named in it, so two differently-filtered sites do not report the same set.
    expect(run(r.NotAdjWs! as never, 'ab').expected).toEqual(['notAdjacent(whitespace)'])
    expect(run(r.Adj! as never, 'a b').expected).toEqual(['adjacent'])
  })

  it('an adjacency marker with NO boundary refuses in every engine, with one sentence', () => {
    // A bare rule body, a repeat item: nowhere for the assertion to look. The
    // interpreter throws rather than answering a question that was never asked
    // (silently answering "no trivia here" makes `adjacent()` invisible), and
    // both drivers reach the same `adjacencyMisuse`.
    const cases: Record<string, Combinator<unknown>> = {
      Bare: adjacent() as Combinator<unknown>,
      Repeated: many(notAdjacent()) as Combinator<unknown>,
    }
    const prog = encodeTable(cases)
    for (const [key, re] of [['Bare', /^adjacent\(\): adjacency assertions are boundary tests/], ['Repeated', /^notAdjacent\(\): adjacency assertions are boundary tests/]] as const) {
      expect(() => run(cases[key]! as never, 'a')).toThrow(re)
      expect(() => run(tableRules(prog)[key]! as never, 'a')).toThrow(re)
      expect(() => run(assembledRules(prog)[key]! as never, 'a')).toThrow(re)
    }
  })

  it('withCtx(extra) EMITS when the state is plain data, and is NAMED when it is not', () => {
    // `extra` is arbitrary user data parked in the const pool. `emitConst` takes
    // scalars, arrays of scalars, and plain objects of those — a plain object
    // round-trips exactly, by the same criterion that admitted arrays.
    //
    // Anything richer RUNS fine but cannot be printed. That must surface as a
    // NAMED runtime-only reason, not a bare TypeError out of the printer: the
    // grammar is not broken, it just cannot be shipped as a module, and the
    // author needs to be told which construct did it.
    const plain = encodeTable({ D: withCtx({ inFn: true, depth: 2, tags: ['a', 'b'] }, literal('a')) as Combinator<unknown> })
    const mod = emitTableModule(plain, { name: 'G' })
    expect(mod).toContain('inFn')
    expect(run(tableRules(plain).D! as never, 'a').ok).toBe(true)

    const rich = encodeTable({ D: withCtx({ fn: () => 1 }, literal('a')) as Combinator<unknown> })
    expect([...rich.runtimeOnly ?? []].join(' ')).toMatch(/withCtx\(extra\)/)
    // …and it still RUNS. Unemittable is not unusable.
    expect(run(tableRules(rich).D! as never, 'a').ok).toBe(true)
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
  // `withCtx` + `gate()` earn a row here specifically because this is the pair
  // that DIVERGED between two shipped engines and nothing noticed. One ran the
  // child on a spread ctx and copied `_fe`/`_fx`/`_fc` back by hand; the
  // interpreter had no such workaround and simply dropped them, so a failing
  // `withCtx` subtree reported a different expected set depending on the engine.
  // All of them save/restore now — and this row is what would catch it coming
  // back, since it is the only assertion here that compares a LOWERED engine to
  // the interpreter on a state-scoped failure.
  const gatedBody = transform(
    sequence(gate((st: unknown) => (st as { inFn?: boolean })?.inFn === true), literal('r')),
    () => 'SAW',
  ) as Combinator<unknown>
  const stateScoped: Record<string, Combinator<unknown>> = {
    Doc: withCtx({ inFn: false }, gatedBody) as Combinator<unknown>,
  }

  // A DISPATCHED choice and a dispatch MISS in one grammar, because the two are
  // the two halves of the rule and only agreeing on both is agreement. `ax`
  // dispatches to arm 0 and every engine names that arm; `zz` (in-bounds miss) and
  // `''` (EOF, which is a miss — a disjoint choice's arms are all non-nullable)
  // name the union. `ax` was a live three-way divergence: the table answered with
  // the static union on the dispatch hit as well.
  const twoLiterals: Record<string, Combinator<unknown>> = {
    Doc: choice(literal('ab'), literal('cd')) as Combinator<unknown>,
  }
  // The SHIPPED json root. Its choice arms are local consts, so `disjoint` is
  // computed from resolved first sets and all three engines dispatch alike —
  // unlike `bench/table-grammars.ts`'s `g.X`-ref spelling, whose stale `disjoint`
  // is pinned separately below.
  const shippedJson: Record<string, Combinator<unknown>> = {
    jsonValue: shippedJsonValue as unknown as Combinator<unknown>,
  }

  const suites = [
    ['withctx-gate', stateScoped, 'Doc', ['r', 'x']],
    ['two-literals', twoLiterals, 'Doc', ['ax', 'zz', '']],
    ['shipped-json', shippedJson, 'jsonValue', ['{"a":]', '{"a":', '[1,2,]', 'nope', '@@@', '']],
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

  it('all four shapes report the SAME expected set in all three engines', () => {
    // All four accept and reject exactly the right inputs, so the identity sweep
    // is blind to every one of them; only the error message moves. Collected here
    // so the size of the divergence is one number rather than a rumour.
    //
    // Characterised, not endorsed: each `toEqual` on the TABLE row is the current
    // behaviour, and each `interp`/`compiled` row is what it should be.
    //
    // WAS FOUR, THEN THREE, NOW NONE. The dispatched-choice miss went first — a
    // choice now carries its own expected set and reports the union on every
    // failing exit. `Min` was second: a list ending under `min` reports the ITEM,
    // which is what `failAt` (repeat.ts) and the source lowering's
    // `deriveExpectedArr([item])` both already reported. `Kw` and `Peek` went with the table-lowering flip:
    // `keywords()` now carries its own `['keyword']` label into the row instead of
    // deriving the literals off the rebuilt regex, and `OP_PEEK` carries the
    // ASSERTION's set instead of letting the body's escape. All four shapes are
    // kept and asserted POSITIVELY, so a regression cannot quietly restore any of
    // them.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      // 1. FIXED — keywords() carries its own label rather than the rebuilt
      //    regex's literals.
      Kw: node('Kw', keywords(['if', 'ifdef'], { boundary: 'a-z' }), c => ({ t: 'Kw', c })),
      // 2. FIXED — the lookahead's INNER expectation no longer escapes.
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
      ['Kw', 'ifx', ['keyword']],
      ['Peek', 'ax', ['peek(literal)']],
    ] as const
    for (const [rule, input, all] of cases) {
      expect(run(t[rule]! as never, input).ok, `${rule} ${input}`).toBe(false)
      expect(run(t[rule]! as never, input).expected, `${rule} table`).toEqual(all)
      expect(run(g[rule]! as never, input).expected, `${rule} interpreter`).toEqual(all)
      expect(run(c[rule] as never, input).expected, `${rule} compiled`).toEqual(all)
    }
    // `Min`, positively: all THREE now name the item. A list stuck under `min` is
    // stuck wanting another ITEM, and says so wherever it runs.
    for (const engine of [t.Min!, g.Min!, c.Min]) {
      expect(run(engine as never, 'a').ok).toBe(false)
      expect(run(engine as never, 'a').expected).toEqual(['/[a-z]/'])
    }
    // THE RESIDUE IS NOT A FAILURE-REPORTING DIVERGENCE. The note here used to
    // call it furthest-failure merging; nothing in the library merges positionally
    // on the `expected` path (`failAt`/`probeUpdate` are `_probe`-gated and surface
    // as `RunResult.furthestFail`). All three drivers apply the SAME rule — a
    // failing choice reports the arms it ATTEMPTED — and disagree about which arms
    // those are.
    //
    // `jsonRules.Value` is `choice(g.Obj, …)`. Those `g.X` arms are `ref()` slots
    // still carrying `any()` when `choice()` runs (ref.ts:21 fills the meta in
    // place, afterwards), so `disjoint` freezes FALSE (choice.ts:35). The two
    // engines read that flag and firstMatch all seven arms, concatenating seven
    // sets; `encode.ts:439` recomputes from resolved classes and dispatches to
    // one, so the table reports that one arm — `["}"]` for `{"a":`, which is
    // exactly what the engines' OWN `Obj` arm returns inside their seven.
    //
    // Pinned as a SUBSET relation, which is the true shape: the table's answer is
    // one of the engines' elements, never a token they did not name. A regression
    // that invents a token, or moves the position, still fails this.
    const jt = tableRules(encodeTable(jsonRules as never)).Value!
    const jc = (compose([jsonRules as never]) as unknown as Record<string, unknown>).Value!
    for (const [bad, dispatched] of [['[1,2,]', '"]"'], ['{"a":', '"}"'], ['nope', '"null"']] as const) {
      const fromTable = run(jt as never, bad)
      const fromInterp = run(jsonRules.Value! as never, bad)
      const fromCompiled = run(jc as never, bad)
      // The position agrees across all three; only the arm count differs.
      expect(fromTable.span, bad).toEqual({ start: 0, end: 0 })
      expect(fromInterp.span, bad).toEqual({ start: 0, end: 0 })
      expect(fromCompiled.span, bad).toEqual({ start: 0, end: 0 })
      // The engines attempt seven arms; the table attempts the one it dispatched.
      expect(fromInterp.expected, bad).toHaveLength(7)
      expect(fromCompiled.expected, bad).toEqual(fromInterp.expected)
      expect(fromTable.expected, bad).toEqual([dispatched])
      expect(fromInterp.expected, `${bad}: the table's token is one of theirs`)
        .toContain(dispatched)
    }
    // All three still REJECT — only the arm count in the report differs.
    for (const bad of ['[1,2,]', '{"a":', 'nope']) {
      for (const r of [run(jt as never, bad), run(jsonRules.Value! as never, bad), run(jc as never, bad)]) {
        expect(r.ok, bad).toBe(false)
      }
    }
    // THE CONTROL. `examples/json/parser.ts` is the same language spelled with
    // local consts, so its arms' first sets are resolved when `choice()` runs,
    // `disjoint` is TRUE everywhere, and all three name the dispatched arm and
    // agree exactly. Same rule, same arms, no divergence — which is what makes
    // the rows above a `disjoint`-staleness finding and not a reporting one.
    const st = tableRules(encodeTable({ jsonValue: shippedJsonValue } as never)).jsonValue!
    const sc = (compose([{ jsonValue: shippedJsonValue } as never]) as unknown as Record<string, unknown>).jsonValue!
    for (const [bad, only] of [['[1,2,]', '"]"'], ['{"a":', '"}"'], ['nope', '"null"']] as const) {
      for (const r of [run(st as never, bad), run(shippedJsonValue as never, bad), run(sc as never, bad)]) {
        expect(r.ok, bad).toBe(false)
        expect(r.expected, `shipped ${bad}`).toEqual([only])
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
