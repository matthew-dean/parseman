import { describe, it, expect } from 'vitest'
import {
  rules, trivia, sequence, literal, oneOrMore, optional, regex, compile, run, parse, parser, noTrivia,
  type Combinator, type ParseContext, type ParseResult,
} from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { assembledRules } from '../../src/table/assemble.ts'

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
      'table(exec)': tableRules(prog)['Decl']!(input, 0, ctx()),
      'table(assembled)': assembledRules(prog)['Decl']!(input, 0, ctx()),
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
