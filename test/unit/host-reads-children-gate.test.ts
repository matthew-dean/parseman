/**
 * `_parsemanReadsChildren === false` lets a structural host that builds ONLY from
 * `rawChildren` (arg 4) elide the per-node `children` array (chV) — a byte-for-byte
 * duplicate of rawChildren for a structural grammar. Arity inference can't detect
 * this: such a host must declare `children` positionally to reach `rawChildren`/
 * `span`/`state`, so `Function.length` stays high and `_hostReads` reports "read".
 *
 * These tests pin: (1) output is byte-identical to the non-opted-out host, (2) the
 * host actually receives `children === undefined` while `rawChildren` is fully
 * populated (leaves + sub-nodes), proving the elision fired without data loss, and
 * (3) the collapse contract (`_parsemanCstCollapse`, which inspects children) keeps
 * chV even when the opt-out is also set.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import { node, regex, sequence, literal, many, trivia, parser, rules, type BuildHost } from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { run } from '../../src/functional/run.ts'

const rw = trivia(regex(/[ \t\n\r\f]+/))
// Nested structural grammar: Doc → many(Pair); Pair → Word ':' Word. Leaves
// (Word terminals + ':') and sub-nodes (Pair) both flow into the collectors.
const grammar = rules({ trivia: rw }, g => ({
  Word: node('Word', regex(/[a-z]+/)),
  Pair: node('Pair', sequence(g.Word, literal(':'), g.Word)),
  Doc: node('Doc', many(g.Pair)),
}))
const { Doc } = grammar
const compiled = compile(Doc)
const reference = execRules(encodeTable(grammar)).Doc!
const INPUT = 'a : b  c : d'

/** Structural host that builds purely from rawChildren, like cssCstBuildHost. */
const fromRaw = (optOut: boolean): BuildHost => {
  const h: BuildHost = (
    type: string,
    _children: ReadonlyArray<unknown>,
    _fields: unknown,
    span: { start: number; end: number },
    rawChildren: ReadonlyArray<unknown>,
  ) => ({ _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren })
  if (optOut) h._parsemanReadsChildren = false
  return h
}

const parse = (build: BuildHost) => {
  const ctx: Record<string, unknown> = { trackLines: false, build }
  const r = compiled.parseWithContext(INPUT, ctx as never, 0)
  return { ctx, r }
}

describe('_parsemanReadsChildren opt-out — structural children-array elision', () => {
  it('preserves the public BuildHost children parameter as a required array', () => {
    // The opt-out is framework-internal. Widening this public parameter to
    // `undefined` makes every existing explicitly typed host fail strict
    // function-variance checks even though it never opts out.
    expectTypeOf<Parameters<BuildHost>[1]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    const ordinary: BuildHost = (_type: string, children: ReadonlyArray<unknown>) => children.length
    expect(ordinary('X', [], undefined, { start: 0, end: 0 }, [], [], undefined)).toBe(0)
  })

  it('restores reference-driver host configuration after a re-entrant parse', () => {
    const nestedGrammar = rules({ trivia: rw }, g => ({
      Child: node('Child', sequence(literal('a'), literal('b'))),
      Doc: node('Doc', sequence(g.Child, g.Child)),
    }))
    const prog = encodeTable(nestedGrammar)
    const entries = [
      ['interpreter', nestedGrammar.Doc],
      ['reference', execRules(prog).Doc!],
      ['emitted assembly', tableRules(prog).Doc!],
      // An `asm` inventory forbids runtime source construction and selects the
      // closure fallback, so both production assembly engines are explicit.
      ['closure assembly', tableRules({ ...prog, asm: [] }).Doc!],
    ] as const

    for (const [engine, entry] of entries) {
      for (const nestedExit of ['return', 'throw'] as const) {
        let nested = false
        const seen: Array<[string, number]> = []
        const innerHost = Object.assign(
          (type: string) => {
            if (nestedExit === 'throw') throw new Error('nested host failure')
            return { type }
          },
          { _parsemanCaptureTrivia: () => false },
        )
        const outerHost = Object.assign(
          (
            type: string,
            _children: ReadonlyArray<unknown>,
            _fields: unknown,
            _span: unknown,
            _raw: ReadonlyArray<unknown>,
            triviaLog: readonly number[],
          ) => {
            seen.push([type, triviaLog.length])
            if (type === 'Child' && !nested) {
              nested = true
              if (nestedExit === 'throw') {
                expect(() => run(entry as never, 'a b a b', { build: innerHost as never })).toThrow('nested host failure')
              } else {
                expect(run(entry as never, 'a b a b', { build: innerHost as never }).ok, engine).toBe(true)
              }
            }
            return { type }
          },
          { _parsemanCaptureTrivia: () => true },
        )

        expect(run(entry as never, 'a b a b', { build: outerHost as never }).ok, `${engine}: ${nestedExit}`).toBe(true)
        expect(seen, `${engine}: ${nestedExit}`).toEqual([['Child', 3], ['Child', 3], ['Doc', 3]])
      }
    }
  })

  it('restores an assembled table host after re-entry without a trivia predicate', () => {
    // The predicate-bearing re-entry case above selects distinct assemblies for
    // the two hosts. Ordinary structural hosts share one assembly, which is the
    // path that used to leave its HOST slot pointed at the nested parser's host.
    const nestedGrammar = rules(g => ({
      Child: node('Child', sequence(literal('a'), literal('b'))),
      Doc: node('Doc', sequence(g.Child, g.Child)),
    }))
    const prog = encodeTable(nestedGrammar)
    const entries = [
      ['emitted assembly', tableRules(prog).Doc!],
      // An empty assembly inventory forbids the Function constructor and proves
      // the linked-closure path restores its own scalar frame too.
      ['closure assembly', tableRules({ ...prog, asm: [] }).Doc!],
    ] as const

    for (const [engine, entry] of entries) {
      for (const nestedExit of ['return', 'throw'] as const) {
        let nested = false
        const calls: string[] = []
        const inner: BuildHost = (type, children, _fields, span, rawChildren) => {
          calls.push(`inner:${type}`)
          if (nestedExit === 'throw') throw new Error('nested host failure')
          return { owner: 'inner', type, children, span, rawChildren }
        }
        const outer: BuildHost = (type, children, _fields, span, rawChildren) => {
          calls.push(`outer:${type}`)
          if (type === 'Child' && !nested) {
            nested = true
            if (nestedExit === 'throw') {
              expect(() => run(entry as never, 'abab', { build: inner })).toThrow('nested host failure')
            } else {
              expect(run(entry as never, 'abab', { build: inner }).ok, engine).toBe(true)
            }
          }
          return { owner: 'outer', type, children, span, rawChildren }
        }

        const result = run(entry as never, 'abab', { build: outer })
        expect(result.ok, `${engine}: ${nestedExit}`).toBe(true)
        expect(calls.filter(c => c.startsWith('outer:')), `${engine}: ${nestedExit}`).toEqual([
          'outer:Child', 'outer:Child', 'outer:Doc',
        ])
        expect(calls.filter(c => c.startsWith('inner:')), `${engine}: ${nestedExit}`).toEqual(
          nestedExit === 'throw'
            ? ['inner:Child']
            : ['inner:Child', 'inner:Child', 'inner:Doc'],
        )
        if (result.ok) expect((result.value as { owner: string }).owner, `${engine}: ${nestedExit}`).toBe('outer')
      }
    }
  })

  it('produces byte-identical output to the non-opted-out host', () => {
    const base = parse(fromRaw(false))
    const opt = parse(fromRaw(true))
    expect(base.r.ok).toBe(true)
    expect(opt.r.ok).toBe(true)
    if (!base.r.ok || !opt.r.ok) return
    expect(JSON.stringify(opt.r.value)).toBe(JSON.stringify(base.r.value))
  })

  it('hands the opt-out host the shared empty children array while rawChildren stays fully populated', () => {
    const seen: Array<{ type: string; children: unknown; rawLen: number }> = []
    const spy: BuildHost = (type, children, _f, span, rawChildren) => {
      seen.push({ type, children, rawLen: rawChildren.length })
      return { _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren }
    }
    spy._parsemanReadsChildren = false
    const { r, ctx } = parse(spy)
    expect(r.ok).toBe(true)
    // every structural node saw an empty sentinel rather than a materialized
    // duplicate of rawChildren…
    expect(seen.every(s => Array.isArray(s.children) && s.children.length === 0)).toBe(true)
    // …but rawChildren carried the real structure: a Pair has 3 (Word, ':', Word),
    // the Doc has 2 Pairs. Proves leaves + sub-nodes reached rawChildren w/o chV.
    const pair = seen.find(s => s.type === 'Pair')!
    expect(pair.rawLen).toBe(3)
    expect(seen.find(s => s.type === 'Doc')!.rawLen).toBe(2)

    seen.length = 0
    const referenceResult = reference(INPUT, 0, { trackLines: false, build: spy })
    expect(referenceResult.ok).toBe(true)
    expect(seen.every(s => Array.isArray(s.children) && s.children.length === 0)).toBe(true)
    expect(seen.find(s => s.type === 'Pair')!.rawLen).toBe(3)
    expect(seen.find(s => s.type === 'Doc')!.rawLen).toBe(2)
  })

  it('keeps children when the host does NOT opt out (default, back-compat)', () => {
    const seen: unknown[] = []
    const host: BuildHost = (type, children, _f, span, rawChildren) => {
      seen.push(children)
      return { _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren }
    }
    const { r, ctx } = parse(host)
    expect(r.ok).toBe(true)
    expect(seen.every(c => Array.isArray(c))).toBe(true)
  })

  it('keeps children for a collapse host even when opt-out is set (collapse inspects children)', () => {
    const host: BuildHost = (type, children, _f, span, rawChildren) =>
      ({ _tag: 'node', type, span: { start: span.start, end: span.end }, children: rawChildren })
    host._parsemanReadsChildren = false
    host._parsemanCstCollapse = () => false
    const seen: unknown[] = []
    const wrapped: BuildHost = (type, children, f, span, raw, tl, st) => {
      seen.push(children)
      return host(type, children, f, span, raw, tl, st)
    }
    wrapped._parsemanReadsChildren = false
    wrapped._parsemanCstCollapse = () => false
    const { r, ctx } = parse(wrapped)
    expect(r.ok).toBe(true)
    // collapse presence forces chV to stay allocated
    expect(seen.every(c => Array.isArray(c))).toBe(true)
  })
})
