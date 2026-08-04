/**
 * A removed field must announce its removal, not read `undefined`.
 *
 * `RunResult.triviaMap` was MANDATORY in 0.43 and was dropped in 0.44 for an
 * opt-in `rootTrivia` capture. A consumer that kept reading it got `undefined`,
 * which then travelled until it hit a property access deep inside the
 * consumer's own code — an error naming neither parseman, the field, nor the
 * replacement. Same defect class as a diagnostic that reports a number when it
 * means "I could not run".
 *
 * These tests pin the two halves of the fix: the read throws with the
 * migration in it, and the accessor is invisible to everything that enumerates
 * the result — so re-adding the name moves no digest.
 *
 * ## And a third half, added in 0.47: it must cost NOTHING per parse
 *
 * "Costs no parse time" was written here as an assertion and was FALSE. The
 * notices were installed by a `guardRemovedFields(result)` that ran three
 * `Object.defineProperty` calls on the result of EVERY `run()`. Measured
 * through `bench/ab-harness.ts`, deleting it outright made `run()` -42% on a
 * 7-byte input and -18% on `SMALL_JSON`, at 12/12 interleaved pairs in every
 * pass — a FIXED per-run cost, so the smallest parses paid the largest share
 * and no size-scaled benchmark ever saw it.
 *
 * The migration text is unchanged and every behaviour below is unchanged; the
 * accessors moved to a SHARED PROTOTYPE built once at module load. So the last
 * test here pins the placement, not just the effect: an own-property
 * descriptor on a result means the per-parse install is back.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, many, node, parser, trivia, choice, run, compile, sequence, field, literal, type ParseContext } from '../../src/index.ts'

/** Read a removed name the way a stale 0.43 consumer would — off a plain
 * record, since the fields are deliberately absent from `RunResult`'s type. */
const read = (r: object, field: string): unknown => (r as unknown as Record<string, unknown>)[field]
const readRemoved = (r: object): unknown => read(r, 'triviaMap')

/** Every field 0.43 guaranteed and 0.44 dropped. */
const REMOVED = ['triviaMap', 'triviaLog', 'triviaKindLabels'] as const

const blockTrivia = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))
const g = rules(gg => ({ Doc: parser({ trivia: blockTrivia }, many(gg.W)), W: node('W', regex(/[a-z]+/)) }))

describe('removed RunResult.triviaMap', () => {
  it('throws a migration message instead of reading undefined', () => {
    const r = run(g.Doc as never, 'a b c')
    expect(() => readRemoved(r)).toThrow(TypeError)
    expect(() => readRemoved(r)).toThrow(/triviaMap was REMOVED in parseman 0\.44\.0/)
    // The message must carry the replacement, not just the removal — a notice
    // that says "gone" and stops is a slightly louder dead end.
    expect(() => readRemoved(r)).toThrow(/rootTrivia/)
  })

  it.each(REMOVED)('names %s, its replacement, and how to ask for it', field => {
    const r = run(g.Doc as never, 'a b c')
    expect(() => read(r, field)).toThrow(TypeError)
    expect(() => read(r, field)).toThrow(new RegExp(`RunResult\\.${field} was REMOVED in parseman 0\\.44\\.0`))
    // A notice that says "gone" and stops is only a louder dead end, so the
    // replacement and the call that produces it are both part of the contract.
    expect(() => read(r, field)).toThrow(/rootTrivia/)
    expect(() => read(r, field)).toThrow(/select:/)
  })

  it('is invisible to enumeration, spread and JSON', () => {
    const r = run(g.Doc as never, 'a b c')
    const keys = Object.keys(r)
    const json = JSON.stringify(r)
    for (const field of REMOVED) {
      expect(keys).not.toContain(field)
      expect(json).not.toContain(field)
    }
    // The spread must not re-trigger the getters, and must not carry them forward.
    expect(() => ({ ...r })).not.toThrow()
    for (const field of REMOVED) expect(Object.keys({ ...r })).not.toContain(field)
  })

  it('installs NOTHING per parse — the notices live on a shared prototype', () => {
    const a = run(g.Doc as never, 'a b c')
    const b = run(g.Doc as never, 'a b c')
    // The placement IS the perf contract. An own descriptor here means a
    // per-parse `defineProperty` came back; a per-result prototype means a
    // per-parse `setPrototypeOf` did.
    for (const field of REMOVED) {
      expect(Object.getOwnPropertyDescriptor(a, field)).toBeUndefined()
      expect(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(a) as object, field)?.get).toBe('function')
    }
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b))
    expect(Object.getPrototypeOf(a)).not.toBe(Object.prototype)
  })

  /* The profiled return path — the one that spread the host pass's result and so
   * had to reinstall the non-enumerable accessor — was removed along with the
   * emitted profiling counters, and `RunOptions.profile` has now gone too, so there
   * is no spread to guard. Restore this pin with the interpreted profiling driver. */
})
