import { describe, it, expect } from 'vitest'
import {
  rules, trivia, sequence, literal, oneOrMore, optional, many, choice, dispatch, when, routed, regex,
  compile, run, parse, parser, noTrivia,
  type Combinator, type ParseContext, type ParseResult,
} from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'

const rw = trivia(oneOrMore(regex(/[ \t\n]+/)))

// Trivia declared ONCE on rules() — no per-rule parser() wrappers anywhere.
function grammar() {
  return rules({ trivia: rw }, (r: any) => ({
    C: sequence(literal('c'), literal('d')),
    B: sequence(literal('b'), r.C),
    A: sequence(literal('a'), r.B),
  })) as Record<string, any>
}

const end = (res: any) => (res.ok ? res.span.end : `FAIL@${res.span?.start}`)

describe('rules({ trivia }, factory) — ambient grammar trivia', () => {
  it('run() makes trivia ambient through the whole rule chain (no parser() wraps)', () => {
    const g = grammar()
    expect(run(g.A, 'a b c d').ok).toBe(true)
    expect(run(g.A, 'a b c d').span.end).toBe(7)
    expect(run(g.A, 'abcd').span.end).toBe(4) // trivia optional
  })

  it('incremental parse of a bare mid-grammar rule still gets the trivia', () => {
    const g = grammar()
    expect(run(g.C, 'c d').span.end).toBe(3)     // C alone skips the space
    expect(run(g.B, 'b  c\td').span.end).toBe(6) // B alone, ws run + tab
  })

  it('compiled ≡ interpreter with trivia only on rules()', () => {
    const g = grammar()
    for (const [rule, input] of [[g.A, 'a b c d'], [g.C, 'c  d'], [g.B, 'b c d'], [g.A, 'abcd']] as const) {
      const i = end(rule.parse(input, 0, { trackLines: false, trivia: rw }))
      const c = end(compile(rule).parse(input))
      expect(c, `compiled must match interpreter for ${JSON.stringify(input)}`).toEqual(i)
    }
  })

  it('parse() and run() entry points both install the grammar trivia', () => {
    const g = grammar()
    // parse() (grammar.ts) reads _meta.grammarTrivia and installs it as ctx.trivia.
    // Calling the raw combinator .parse() with a bare ctx would NOT, and would fail
    // on the spaces — so a successful, fully-consumed parse proves the install works.
    const viaParse = parse(g.A, 'a b c d')
    expect(viaParse.ok).toBe(true)
    expect(viaParse.ok && viaParse.span.end).toBe(7)
    // control: raw .parse() with no trivia in the ctx fails on the first space.
    expect(g.A.parse('a b c d', 0, { trackLines: false }).ok).toBe(false)
    // run() entry
    expect(run(g.A, 'a b c d').ok).toBe(true)
  })

  it('parser({trivia}) / noTrivia still override the grammar default locally', () => {
    // A glued rule using noTrivia inside a grammar whose default is rw.
    const g = rules({ trivia: rw }, (r: any) => ({
      glued: noTrivia(sequence(literal('x'), literal('y'))),
      spaced: sequence(literal('x'), literal('y')),
    })) as Record<string, any>
    // spaced: grammar default rw → "x y" parses
    expect(run(g.spaced, 'x y').ok).toBe(true)
    // glued: noTrivia override → "x y" must FAIL (space not skipped), "xy" ok
    expect(run(g.glued, 'xy').ok).toBe(true)
    expect(run(g.glued, 'x y').ok).toBe(false)
  })

  it('grammars without rules({trivia}) are unaffected (opt-in)', () => {
    const g = rules((r: any) => ({ AB: sequence(literal('a'), literal('b')) })) as Record<string, any>
    // No ambient trivia → "ab" parses, "a b" fails (space breaks the contiguous match).
    expect(run(g.AB, 'ab').span.end).toBe(2)
    expect(run(g.AB, 'a b').ok).toBe(false)
  })
})

/**
 * A TRIVIA SCOPE IS LEXICAL, PER RULE — it does not follow a `g.X` reference.
 *
 * This is the shape that truncated jess's 107 KB `benchmark.less` at byte 73117 —
 * 68.5% of the file — while every engine returned `ok: true` with an empty
 * `errors` array, and every one of this repo's 3318 tests passed.
 *
 * `StandardDeclaration` in jess's Less grammar wraps its value in `noTrivia(...)`
 * so the property, colon and value stay contiguous, and the `!important` tail lives
 * in the REFERENCED rule `ValueListWithPriority`. Codegen binds each rule's trivia
 * scanner at COMPILE time, so the referenced rule always ran under its own ambient
 * trivia and `color: red !important` parsed. The interpreter read `ctx.trivia` and
 * the table jumped a reference straight to the target's body past its `OP_SCOPE` —
 * both scoped trivia DYNAMICALLY, by caller. A rule's meaning therefore depended on
 * where it was called from, and the space before `!` became uncrossable.
 *
 * The engines did not disagree about an error message. They parsed DIFFERENT
 * LANGUAGES, and the one that shipped changed at 0.47 when the table became the
 * macro's output.
 *
 * THE ABSOLUTE ASSERTIONS ARE THE POINT, and this case shows exactly why a relative
 * one is not enough. At this release `compile()` lowers THROUGH the table, so three
 * of the four legs below share the table's answer and the only engine that ever got
 * this right — 0.46's inlined codegen — is not reachable from this worktree at all.
 * A pure engine-vs-engine check would therefore have gone green on a three-to-one
 * majority that was wrong. So every case pins the byte count it must reach, and the
 * agreement check sits alongside it rather than standing in for it.
 *
 * The two halves of the fix are independently load-bearing and independently pinned:
 * disabling the interpreter's (`ref.ts`) drops `interpreted` to `ok@3`, and disabling
 * the encoder's (`encode.ts` `scopedRef`) drops the three table-backed legs to `ok@3`.
 */
describe('rules({ trivia }) — a reference re-establishes the target rule\'s scope', () => {
  /**
   * The minimal replica: the caller clears trivia for its OWN terms, and the space
   * that has to be crossed sits at a boundary INSIDE the referenced rule.
   */
  function priorityGrammar(): Record<string, Combinator<unknown>> {
    return rules({ trivia: rw }, (r: Record<string, Combinator<unknown>>) => ({
      Value: sequence(literal('v'), optional(sequence(literal('!'), literal('important')))),
      Decl: noTrivia(sequence(literal('a'), literal(':'), r.Value!)),
    })) as unknown as Record<string, Combinator<unknown>>
  }

  /** All four engines: interpreter, compiled, and both table drivers. */
  function fourEngines(input: string): Record<string, string> {
    const g = priorityGrammar()
    const prog = encodeTable({ Value: g.Value!, Decl: g.Decl! }, {})
    const ctx = (): ParseContext => ({ trackLines: false, trivia: rw } as ParseContext)
    const results: Record<string, ParseResult<unknown>> = {
      interpreted: g.Decl!.parse(input, 0, ctx()),
      // A compiled entry BAKES its trivia in, so it takes no ctx — see the
      // `compiled ≡ interpreter` case above, which calls it the same way.
      compiled: compile(g.Decl!).parse(input),
      'table(exec)': execRules(prog)['Decl']!(input, 0, ctx()),
      'table(assembled)': tableRules(prog)['Decl']!(input, 0, ctx()),
    }
    const out: Record<string, string> = {}
    for (const [name, res] of Object.entries(results)) {
      out[name] = res.ok ? `ok@${res.span.end}` : `FAIL@${res.span?.start}`
    }
    return out
  }

  it('crosses the space before the tail INSIDE the referenced rule, in all four engines', () => {
    // Before the fix: interpreter and both table drivers stopped at 3 (`a:v`) and
    // reported ok with `unconsumedFrom: 3`; only `compiled` reached 14. That is the
    // truncation, in fourteen bytes.
    const got = fourEngines('a:v !important')
    for (const name of Object.keys(got)) {
      expect(got[name], `${name} must consume the whole input`).toBe('ok@14')
    }
  })

  it('the tight spelling was never broken — it is the control, not the fix', () => {
    // `a:v!important` needs no trivia crossed, so it passed throughout and proves
    // the case above is about the GAP and nothing else.
    const got = fourEngines('a:v!important')
    for (const name of Object.keys(got)) {
      expect(got[name], `${name} must consume the whole input`).toBe('ok@13')
    }
  })

  it('noTrivia STILL binds the terms it lexically encloses', () => {
    // The fix must not be "noTrivia stopped working": the caller's OWN terms are
    // still contiguous, so a space between `a` and `:` must fail in every engine.
    const got = fourEngines('a : v')
    for (const name of Object.keys(got)) {
      expect(got[name], `${name} must reject a gap inside the noTrivia scope`).toBe('FAIL@1')
    }
  })

  it('all four engines agree — no engine is the outlier', () => {
    for (const input of ['a:v !important', 'a:v!important', 'a : v', 'a:v']) {
      const got = fourEngines(input)
      const answers = new Set(Object.values(got))
      expect(answers.size, `engines disagree on ${JSON.stringify(input)}: ${JSON.stringify(got)}`).toBe(1)
    }
  })
})

/**
 * ...AND ONLY WHERE THE REFERENCED RULE HAS A BOUNDARY TO REPAIR.
 *
 * The repair above re-establishes a rule's ambient trivia when it is referenced
 * from a region that CLEARED it. Applied to EVERY reference it does not narrow a
 * `noTrivia(...)` region — it ENDS it, because the restored scope is then inherited
 * by whatever the referenced rule delegates to.
 *
 * jess's shipping SCSS grammar sits on that second seam. `ValueTerm` clears trivia
 * and spells its own separators; `MathUnary` — `choice(noTrivia(…), noTrivia(…),
 * g.ValueAtom)` — is a bare ALTERNATION, so an ambient scanner installed for it
 * repairs nothing about `MathUnary` and everything about its third arm. Through
 * `g.ValueAtom` it reached `KeywordOrInterpolatedValue`, whose `many()`
 * concatenates identifier chunks, and whitespace was skipped between its terms.
 * `a{b: c d}` then produced the ONE keyword `bc` with `ok: true` and no errors, and
 * `gen-workload.scss` stopped at byte 218 of 287543 in all three engines.
 *
 * So the gate is structural (`hasOwnTriviaBoundary`) and BOTH engines apply it: a
 * body that is an alternation, a dispatch, or a single terminal never consults an
 * ambient scanner itself, so it is given no scope. The replica below is that shape
 * in five bytes, and the load-bearing assertion is the FAILURE — a gap the grammar
 * forbids must stay forbidden however many references deep the glued rule sits.
 */
describe('rules({ trivia }) — a reference does NOT re-establish a scope its target cannot use', () => {
  /**
   * `glued` must never cross a gap, and — as in SCSS — it is INLINE behind a route,
   * not a rule of its own: the only rule between the `noTrivia(...)` and it is
   * `Alt`, a bare alternation. That is the whole shape. A replica that made `glued`
   * its own rule would test nothing, because a reference to a rule that DOES have a
   * boundary is exactly the case the scope is for.
   */
  const glued = dispatch(literal('x'), when('x', sequence(routed(), literal('y'))))

  function gluedGrammar(): Record<string, Combinator<unknown>> {
    return rules({ trivia: rw }, (r: Record<string, Combinator<unknown>>) => ({
      Alt: choice(literal('n'), glued),
      List: noTrivia(sequence(r.Alt!, many(sequence(literal(' '), r.Alt!)))),
    })) as unknown as Record<string, Combinator<unknown>>
  }

  /** The same four legs as above: interpreter, compiled, and both table drivers. */
  function fourEngines(input: string): Record<string, string> {
    const g = gluedGrammar()
    const prog = encodeTable({ Alt: g.Alt!, List: g.List! }, {})
    const ctx = (): ParseContext => ({ trackLines: false, trivia: rw } as ParseContext)
    const results: Record<string, ParseResult<unknown>> = {
      interpreted: g.List!.parse(input, 0, ctx()),
      compiled: compile(g.List!).parse(input),
      'table(exec)': execRules(prog)['List']!(input, 0, ctx()),
      'table(assembled)': tableRules(prog)['List']!(input, 0, ctx()),
    }
    // ACCEPTANCE, not the diagnostic. The four engines report different failure
    // OFFSETS for a rejected route here (0 from the interpreter, 1 from the other
    // three) — a pre-existing difference in where a dispatch reports its miss, and
    // not what this describe block is about. The language is: does `x y` parse.
    const out: Record<string, string> = {}
    for (const [name, res] of Object.entries(results)) {
      out[name] = res.ok ? `ok@${res.span.end}` : 'FAIL'
    }
    return out
  }

  it('a gap inside the glued route stays forbidden two references down, in all four engines', () => {
    // THE DEFECT, in three bytes. With a scope installed for `Alt`, the route's
    // body inherited it and crossed the space: every engine answered ok@3 for input
    // the grammar forbids. That is the same skip that glued SCSS `c d` into `cd`.
    const got = fourEngines('x y')
    for (const name of Object.keys(got)) {
      expect(got[name], `${name} must reject the gap inside the glued route`).toBe('FAIL')
    }
  })

  it('the separator the caller DID spell still works', () => {
    // Not "noTrivia got stricter": the region's own ` ` separator still joins two
    // glued atoms, so the gate removes exactly the skip nobody asked for.
    const got = fourEngines('xy xy')
    for (const name of Object.keys(got)) {
      expect(got[name], `${name} must consume the whole input`).toBe('ok@5')
    }
  })

  it('all four engines agree — no engine is the outlier', () => {
    for (const input of ['x y', 'xy xy', 'xy', 'n xy']) {
      const got = fourEngines(input)
      const answers = new Set(Object.values(got))
      expect(answers.size, `engines disagree on ${JSON.stringify(input)}: ${JSON.stringify(got)}`).toBe(1)
    }
  })
})
