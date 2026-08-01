import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { opHistogram, reachableOps } from '../../src/table/inspect.ts'
import { resolveTable, type TableProgram } from '../../src/table/program.ts'
import { OP_EMPTY, OP_NODE } from '../../src/table/ops.ts'
import { run } from '../../src/functional/run.ts'
import { compose } from '../../src/compiler/linker.ts'
import { selectNodes } from '../../bench/table-grammars.ts'
import {
  choice, dispatch, expect as expectC, isParseError, leaf, literal, many, node, not, otherwise,
  peek, regex, routed, rules, sepBy, sequence, token, transform, when, type Combinator,
} from '../../src/index.ts'

/**
 * DRIVER ROWS THAT NO GRAMMAR IN THE SUITE REACHED.
 *
 * `pnpm test:coverage` reported these `exec.ts` cases as never executed:
 * OP_PEEK, OP_NOT's success path, OP_EXPECT, OP_LEAF, the OP_ROUTED fallback,
 * a failing OP_CALL, the non-ASCII arm of choice dispatch, the zero-width break
 * in OP_REP, and — the one worth saying out loud — the COLLAPSE branch of
 * OP_NODE, despite two existing tests named after collapse.
 *
 * Every case here reads a value back. "It parsed" is not evidence that the row
 * ran: most of these rows are only distinguishable by the value they produce.
 */

const one = (rule: unknown, input: string, opts?: Record<string, unknown>): unknown =>
  run(rule as never, input, opts as never).value

describe('table driver — rows the grammar corpus never reached', () => {
  it('COLLAPSE really collapses — and no existing case ever ran it', () => {
    // `selectNodes.Doc` tries Proj, then Unwr, then Coll. Every input the suite
    // used ('abc', '123', 'abc123', '', '###') is claimed by Proj or Unwr, so the
    // collapse branch of OP_NODE executed on NO test path — while two tests carry
    // "collapse" in their names. 'zz' is the input that reaches it.
    const table = tableRules(encodeTable(selectNodes)).Doc!
    const kid = (one(table, 'zz') as { c: unknown[] }).c[0] as Record<string, unknown>
    // Collapsed: the value IS the single captured child, so the `Coll` wrapper is
    // gone and the Marker surfaces in its place. Not collapsing would leave a
    // node typed 'Coll'; collapsing to the wrong thing would lose the 't'.
    expect(kid.t).toBe('Marker')
    expect((kid.c as Array<{ value: string }>)[0]!.value).toBe('zz')
    // Same tree from the interpreter — the collapse is the ENGINE's, not a quirk.
    expect(JSON.stringify(one(table, 'zz'))).toBe(JSON.stringify(one(selectNodes.Doc, 'zz')))
  })

  it('collapse at an arity OTHER than one falls through to the default CST node', () => {
    // `collapse` applies only at exactly one captured child. At two there is no
    // selection to make and no builder to call, so the driver emits its default
    // node. The existing test for this asserted only `children.length > 0`, which
    // is true of every outcome including no collapse handling at all.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Two: node('Two', sequence(literal('a'), literal('b')), { collapse: true }),
      One: node('One', sequence(literal('a')), { collapse: true }),
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g))
    const two = one(t.Two, 'ab') as Record<string, unknown>
    expect(two._tag).toBe('node')
    expect(two.type).toBe('Two')
    expect((two.children as unknown[]).length).toBe(2)
    // …and at exactly one child the same rule shape DOES collapse, to the leaf.
    const single = one(t.One, 'a') as Record<string, unknown>
    expect(single._tag).toBe('leaf')
    expect(single.value).toBe('a')
    expect(JSON.stringify(two)).toBe(JSON.stringify(one(g.Two, 'ab')))
    expect(JSON.stringify(single)).toBe(JSON.stringify(one(g.One, 'a')))
  })

  it('peek() succeeds at ZERO width and not() consumes nothing either', () => {
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Peeked: transform(sequence(peek(literal('ab')), literal('a')), v => (v as unknown[])[1]) as Combinator<unknown>,
      NotB: transform(sequence(not(literal('b')), literal('a')), v => (v as unknown[])[1]) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g))
    // The peek must not eat 'ab' — the literal after it still has to match 'a'.
    const peeked = run(t.Peeked! as never, 'ab')
    expect(peeked.ok).toBe(true)
    expect(peeked.value).toBe('a')
    expect(peeked.span.end).toBe(1)
    expect(run(t.Peeked! as never, 'ax').ok).toBe(false)
    expect(run(t.NotB! as never, 'a').ok).toBe(true)
    expect(run(t.NotB! as never, 'b').ok).toBe(false)
    // Accept/reject and value agree with the interpreter. The reported EXPECTED
    // set does not — see the diagnostics defect in table-encode-refusals.test.ts.
    for (const [rule, input] of [['Peeked', 'ab'], ['Peeked', 'ax'], ['NotB', 'a'], ['NotB', 'b']] as const) {
      const a = run(t[rule]! as never, input), b = run(g[rule]! as never, input)
      expect(a.ok, `${rule} ${input}`).toBe(b.ok)
      expect(JSON.stringify(a.value), `${rule} ${input}`).toBe(JSON.stringify(b.value))
    }
  })

  it('expect() never fails: a miss yields a ParseError VALUE at zero width', () => {
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: transform(sequence(literal('a'), expectC(literal('b'), 'a b')), v => (v as unknown[])[1]) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    const hit = run(t as never, 'ab')
    expect(hit.ok).toBe(true)
    expect(hit.value).toBe('b')
    const miss = run(t as never, 'a')
    expect(miss.ok).toBe(true)                  // the PARSE succeeds…
    expect(isParseError(miss.value)).toBe(true) // …with an error VALUE in the tree.
    expect((miss.value as { span: unknown }).span).toEqual({ start: 1, end: 1 })
    expect((miss.value as { expected: string[] }).expected).toEqual(['a b'])
    expect(JSON.stringify(miss)).toBe(JSON.stringify(run(g.Doc! as never, 'a')))
  })

  it('leaf() reducers run and receive the matched span', () => {
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: leaf(sequence(literal('ab'), literal('cd')), (_v, span) => `${span.start}-${span.end}`) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    expect(one(t, 'abcd')).toBe('0-4')
    expect(one(t, 'abcd')).toBe(one(g.Doc, 'abcd'))
  })

  it('routed() outside its dispatch falls back, and fails when it has no fallback', () => {
    // The routed token exists only while a dispatch branch is running. Reached at
    // any other position, `routed()` takes its fallback — or fails outright.
    const withFallback = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: routed(literal('x')) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const bare = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: routed() as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const fb = tableRules(encodeTable(withFallback)).Doc!
    expect(one(fb, 'x')).toBe('x')
    expect(run(fb as never, 'y').ok).toBe(false)
    const none = tableRules(encodeTable(bare)).Doc!
    expect(run(none as never, 'x').ok).toBe(false)
    expect(run(none as never, 'x').expected).toEqual(['routed()'])
    expect(JSON.stringify(run(fb as never, 'y'))).toBe(JSON.stringify(run(withFallback.Doc! as never, 'y')))
  })

  it('a failed dispatch branch COMMITS inside a table', () => {
    // The selector already matched, so the interpreter and the compiled path
    // both treat a failed dispatch BRANCH as a hard failure: an enclosing choice
    // must not treat it as "try the next arm", and an enclosing repetition must
    // not treat it as "the list ended". The driver SETS `ctx._fc` (exec.ts, the
    // OP_DISPATCH failure path) and then never READS it — there is no `_fc` test
    // anywhere in exec.ts, while codegen tests it at every choice, sequence and
    // repetition boundary.
    //
    // FIXED. The driver now clears `_fc` before each speculative attempt and
    // propagates on a committed failure at every boundary the shipped engines
    // use (repeat.ts:58/141/215/233/277, choice.ts:109/157). Asserted against
    // BOTH engines rather than against an expected literal, so this stays a
    // three-way agreement rather than a restatement of the current behaviour.
    const inChoice = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: choice(
        dispatch(regex(/@[a-z]+/), when('@x', literal('!'))) as unknown as Combinator<unknown>,
        regex(/@[a-z]+/) as Combinator<unknown>,
      ) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(inChoice)).Doc!
    const compiledChoice = (compose([inChoice as never]) as unknown as Record<string, unknown>).Doc!
    expect(one(t, '@x!')).toEqual(['@x', '!'])          // the arm, when it works
    // The cut: the second arm must NOT re-recognise `@x`.
    expect(run(t as never, '@x').ok).toBe(false)
    expect(run(inChoice.Doc! as never, '@x').ok).toBe(false)   // interpreter
    expect(run(compiledChoice as never, '@x').ok).toBe(false)  // compiled
    expect(run(t as never, '@x').unconsumedFrom).toBe(run(inChoice.Doc! as never, '@x').unconsumedFrom)

    // The shape that matters for a real grammar — `many(AtRule)`. This is where
    // the defect was worst: the table used to report SUCCESS with a silently
    // truncated document. All three engines must now reject.
    const inMany = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: many(dispatch(regex(/@[a-z]+/), when('@x', transform(literal('!'), () => 'hit'))) as unknown as Combinator<unknown>) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const tm = tableRules(encodeTable(inMany)).Doc!
    const compiledMany = (compose([inMany as never]) as unknown as Record<string, unknown>).Doc!
    const fromTable = run(tm as never, '@x!@x')
    expect(fromTable.ok).toBe(false)
    expect(run(inMany.Doc! as never, '@x!@x').ok).toBe(false)
    expect(run(compiledMany as never, '@x!@x').ok).toBe(false)
    // No truncated document: a partial list must not be reported as the value.
    expect(fromTable.value).toBeUndefined()
    // And the well-formed input still parses, so the cut did not become a wall.
    expect(run(tm as never, '@x!@x!').ok).toBe(true)
  })

  it('choice dispatch over NON-ASCII first chars picks the right arm', () => {
    // The ascii lookup covers < 128; anything above goes through the `hi` triples.
    // A table that only filled the byte array would fall through to the ordered
    // scan — same result, different work — or, with no open arm, fail outright.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: choice(
        transform(regex(/[à-ÿ]+/), v => `accent:${String(v)}`),
        transform(regex(/[\u{1F600}-\u{1F64F}]+/u), v => `emoji:${String(v)}`),
        transform(regex(/[0-9]+/), v => `digit:${String(v)}`),
      ) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    expect(one(t, 'é')).toBe('accent:é')
    expect(one(t, '\u{1F600}')).toBe('emoji:\u{1F600}')
    expect(one(t, '7')).toBe('digit:7')
    expect(run(t as never, 'a').ok).toBe(false)
    // Values agree with the interpreter on every accepted input. (The reported
    // expected set on a MISS does not — see table-encode-refusals.test.ts.)
    for (const input of ['é', '\u{1F600}', '7']) {
      expect(JSON.stringify(run(t as never, input)), input).toBe(JSON.stringify(run(g.Doc! as never, input)))
    }
  })

  it('an astral arm is rejected by the table AND the compiled path (interpreter differs)', () => {
    // Disjoint single-character arms above U+007F land in the dispatch table's
    // `hi` triples. The BMP ones are picked correctly; an ASTRAL one is not
    // matched — and the COMPILED path rejects it too, so this is a pre-existing
    // first-set/code-point divergence with the interpreter and not something the
    // table introduced. Pinned here so the table is not blamed for it later, and
    // so a fix that moves one engine has to move the other.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: choice(
        transform(literal('é'), () => 'e-acute'),
        transform(literal('ü'), () => 'u-uml'),
        transform(literal('\u{1F600}'), () => 'grin'),
      ) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    const compiled = (compose([g as never]) as unknown as Record<string, unknown>).Doc!
    expect(one(t, 'é')).toBe('e-acute')
    expect(one(t, 'ü')).toBe('u-uml')
    expect(run(t as never, '\u{1F600}').ok).toBe(false)
    expect(run(compiled as never, '\u{1F600}').ok).toBe(false)
    expect(one(g.Doc, '\u{1F600}')).toBe('grin')

    // NOTE ON THIS TEST'S TITLE. It carried a SECOND, independent claim: that a
    // dispatch miss reports an empty expected set. That half is now fixed and
    // has moved to its own test below — the astral divergence above is
    // unaffected by it and remains pinned here on its own.
  })

  it('a dispatch miss names every arm, as both shipped engines do', () => {
    // Was pinned as a defect: when no arm claimed the first character the driver
    // returned without recording a position or an expected set, so the failure
    // carried no diagnosis at all — a user got an error naming nothing. The
    // choice now carries its own expected set and reports it on every failing
    // exit. Compared to both engines by LENGTH and CONTENT, not by a literal.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: choice(
        transform(literal('é'), () => 'e-acute'),
        transform(literal('ü'), () => 'u-uml'),
        transform(literal('\u{1F600}'), () => 'grin'),
      ) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    const compiled = (compose([g as never]) as unknown as Record<string, unknown>).Doc!
    const fromTable = run(t as never, 'e').expected
    expect(fromTable).toHaveLength(3)
    expect([...fromTable].sort()).toEqual([...run(g.Doc! as never, 'e').expected].sort())
    expect([...fromTable].sort()).toEqual([...run(compiled as never, 'e').expected].sort())
  })

  it('a failing OP_CALL reports the combinator\'s OWN position and expectations', () => {
    // No node() gate in front of it, so the call really runs and really fails —
    // the branch that turns a combinator's `ok: false` back into the driver's
    // FAIL sentinel.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: token(sequence(literal('a'), literal('b'))) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    const miss = run(t as never, 'ax')
    expect(miss.ok).toBe(false)
    expect(JSON.stringify(miss)).toBe(JSON.stringify(run(g.Doc! as never, 'ax')))
    expect(miss.expected.length).toBeGreaterThan(0)
  })

  it('a zero-width repetition item terminates the loop instead of spinning', () => {
    // `many(optional(x))` matches empty forever. The driver breaks when an item
    // consumed nothing; without that the parse never returns.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: many(transform(literal(''), () => 'z')) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    const out = run(t as never, 'abc')
    expect(out.ok).toBe(true)
    expect(out.value).toEqual([])
    expect(out.span.end).toBe(0)
    expect(JSON.stringify(out)).toBe(JSON.stringify(run(g.Doc! as never, 'abc')))
  })

  it('sepBy honours min', () => {
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Two: sepBy(regex(/[a-z]/), literal(','), { min: 2 }) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g))
    expect(run(t.Two! as never, 'a').ok).toBe(false)
    expect(one(t.Two, 'a,b')).toEqual(['a', 'b'])
    // Accept/reject and value parity. (The expected SET on the `min` failure
    // diverges — see the diagnostics defect in table-encode-refusals.test.ts.)
    for (const input of ['a', 'a,b', 'a,b,c']) {
      const a = run(t.Two! as never, input), b = run(g.Two! as never, input)
      expect(a.ok, input).toBe(b.ok)
      expect(JSON.stringify(a.value), input).toBe(JSON.stringify(b.value))
    }
  })

  it('sepBy({ trailing: \'allow\' }) consumes the trailing separator', () => {
    // WAS a defect: the encoder wrote the option into bit 0 of the repetition's
    // flags word and the driver read only bit 1 (`keepSeparators`), so the
    // opt-in was encoded and ignored — the list parsed with the same items and
    // stopped one character early, which in a larger grammar is a parse failure
    // somewhere else entirely. Bit 0 is now read.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Trail: sepBy(regex(/[a-z]/), literal(','), { trailing: 'allow' }) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Trail!
    const compiled = (compose([g as never]) as unknown as Record<string, unknown>).Trail!
    // FIXED — bit 0 is read. The trailing separator is consumed, matching both
    // shipped engines, and the ITEMS are unchanged (a list contributes its items
    // and nothing else, so the separator must not appear in the value).
    const fromTable = run(t as never, 'a,b,')
    expect(fromTable.value).toEqual(['a', 'b'])
    expect(fromTable.span.end).toBe(4)
    expect(fromTable.unconsumedFrom).toBe(null)
    expect(run(g.Trail! as never, 'a,b,').span.end).toBe(4)
    expect(run(compiled as never, 'a,b,').span.end).toBe(4)
    // The CONTRAST that makes this about the bit rather than the parse: the
    // default `forbid` list must still stop before the separator.
    const forbid = rules<Record<string, Combinator<unknown>>>(() => ({
      Trail: sepBy(regex(/[a-z]/), literal(',')) as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const tf = tableRules(encodeTable(forbid)).Trail!
    expect(run(tf as never, 'a,b,').span.end).toBe(3)
    expect(run(forbid.Trail! as never, 'a,b,').span.end).toBe(3)
  })
})

/**
 * Hand-built programs. The driver's contract is with the TABLE, not with the
 * encoder, so the rows an encoder cannot currently produce are reached as data.
 */
describe('table driver — contract with the table itself', () => {
  const prog = (code: readonly number[], rules_: Record<string, number>): TableProgram =>
    ({ code, k: [], fns: [], cc: [], fx: [], disp: [], dsp: [], rules: rules_ })

  it('OP_EMPTY succeeds at zero width', () => {
    const r = run(tableRules(prog([OP_EMPTY], { Doc: 0 })).Doc! as never, 'abc')
    expect(r.ok).toBe(true)
    expect(r.value).toBe('')
    expect(r.span).toEqual({ start: 0, end: 0 })
  })

  it('an unknown opcode THROWS in the driver and in the inspector', () => {
    // Both readers decode the same stream. A new row taught to one and not the
    // other is the failure this pair of throws exists to make loud.
    const bogus = prog([9999], { Doc: 0 })
    expect(() => run(tableRules(bogus).Doc! as never, 'a')).toThrow(/unknown opcode 9999/)
    expect(() => reachableOps(bogus)).toThrow(/unknown opcode 9999/)
  })

  it('the resolved table is built ONCE per program object', () => {
    // `resolveTable` memoizes on the program, which is the (grammar, settings)
    // pair. Two calls returning two objects would rebuild every char class and
    // every dispatch map on each parse entry.
    const p = encodeTable(selectNodes)
    expect(resolveTable(p)).toBe(resolveTable(p))
    expect(resolveTable(encodeTable(selectNodes))).not.toBe(resolveTable(p))
  })

  it('the inspector counts REACHABLE rows, not raw words', () => {
    // Operands are ordinary numbers and collide with opcode values, so a
    // histogram over the word stream reports confident nonsense. Reachability
    // from the rule entries is the only correct read — asserted by a count that a
    // word-scan would get wrong.
    const g = rules<Record<string, Combinator<unknown>>>(gg => ({
      A: node('A', literal('a'), c => ({ c })),
      B: node('B', literal('b'), c => ({ c })),
      Doc: node('Doc', many(choice(gg.A!, gg.B!)), c => ({ c })),
    })) as unknown as Record<string, Combinator<unknown>>
    const p = encodeTable(g)
    const hist = opHistogram(p)
    expect(hist.NODE).toBe(3)      // exactly the three node() rules
    expect(hist.LIT).toBe(2)
    expect(hist.CHOICE).toBe(1)
    expect(hist.GATE).toBe(2)      // first-set gates on the two gated rules
    expect(hist.REPV).toBe(1)
    // Every counted opcode is a real NODE row in the stream at that many places.
    const nodeRows = p.code.filter(w => w === OP_NODE).length
    expect(nodeRows).toBeGreaterThanOrEqual(hist.NODE!)
  })
})

/**
 * `otherwise()` + `routed()` — the fallback OWNS the selector's token.
 */
describe('table driver — dispatch fallback ownership', () => {
  it('an otherwise() WITHOUT routed() leaves the token unconsumed', () => {
    // With `routed()` the fallback consumes the selector's token (pinned by the
    // existing suite). Without it, the arm starts AFTER the token — so a grammar
    // that re-read the token here would double-consume it.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: dispatch(
        regex(/@[a-z]+/),
        when('@x', transform(literal('!'), () => 'hit')),
        otherwise(transform(literal('!'), () => 'other')),
      ) as unknown as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    expect(one(t, '@x!')).toEqual(['@x', 'hit'])
    expect(one(t, '@y!')).toEqual(['@y', 'other'])
    expect(JSON.stringify(run(t as never, '@y!'))).toBe(JSON.stringify(run(g.Doc! as never, '@y!')))
  })
})

/**
 * OPCODE NAMES ARE A SECOND COPY OF THE OPCODE LIST.
 *
 * `OP_NAMES` is written by hand beside 30 `OP_*` constants, and `opHistogram`
 * is the only thing that reads it — so a missing entry surfaces as `undefined`
 * in a diagnostic (`bench/table-opcode-gaps.ts:74`) or as `op29` from
 * `inspect.ts:81`, never as a failure. `OP_TOKEN` was missing exactly that way.
 *
 * Asserted over the MODULE's exports rather than a written-out list, so a new
 * opcode cannot be added without its name.
 */
describe('OP_NAMES covers every declared opcode', () => {
  it('has an entry for each OP_* constant, and no stray ones', async () => {
    const ops = await import('../../src/table/ops.ts')
    const names: Record<number, string> = ops.OP_NAMES
    const declared: Array<[string, number]> = Object.entries(ops as Record<string, unknown>)
      .filter(([n, v]) => n.startsWith('OP_') && n !== 'OP_NAMES' && typeof v === 'number')
      .map(([n, v]) => [n, v as number])
    expect(declared.length).toBeGreaterThan(25)
    const missing = declared.filter(([, code]) => names[code] === undefined).map(([n]) => n)
    expect(missing, 'every opcode must report a readable name, not undefined').toEqual([])
    // Names are unique: two opcodes sharing a name makes a histogram silently
    // merge two rows into one number.
    const spelled = declared.map(([, code]) => names[code]!)
    expect(new Set(spelled).size).toBe(spelled.length)
  })
})

/**
 * `_fc` IS RESET AT THE PARSE BOUNDARY, LIKE `_fe` AND `_fx`.
 *
 * The entry wrapper resets the failure position and expected set on every call
 * because a `ParseContext` is reused across parses. `_fc` — the committed-failure
 * bit `OP_DISPATCH` sets and the cut reads — was left as the caller found it.
 * Today no reader can observe the stale value (each writes `false` immediately
 * before the `exec` it guards), so this pins the boundary invariant itself: a
 * parse must not END carrying a commitment it did not make.
 */
describe('table driver — the committed bit does not survive a parse', () => {
  it('clears a stale _fc on entry, on a grammar that never writes it', () => {
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      // A bare literal: no choice, no optional, no repetition — so nothing in
      // this parse assigns `_fc` and only the entry reset can clear it.
      Doc: literal('a') as unknown as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const t = tableRules(encodeTable(g)).Doc!
    const ctx = { _fc: true } as unknown as Parameters<typeof t>[2]
    const r = t('a', 0, ctx)
    expect(r.ok).toBe(true)
    expect((ctx as unknown as { _fc?: boolean })._fc, 'a committed failure must not leak across parses').toBe(false)
  })
})
