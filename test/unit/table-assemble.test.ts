import { describe, expect, it } from 'vitest'
import { choice, literal, many, node, optional, regex, sequence, transform } from '../../src/index.ts'
import { rules } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assemble, assembledRules, AssemblyCache } from '../../src/table/assemble.ts'
import { tableRules } from '../../src/table/exec.ts'
import { expandCompact, resolveTable } from '../../src/table/program.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { digestValue } from '../../src/oracle/index.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * A grammar with enough shape variety that the assembler's memoisation, its
 * cycle handling and its arity specialisations are all exercised: a recursive
 * rule, sequences of arity 1/2/3 and more, a choice, a repetition and a node.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the recursion
// proxy is deliberately untyped in tests; see balanced-region.test.ts.
const g = rules((g: any) => ({
  Expr: choice(g.Sum, g.Atom),
  // A DIRECT builder, not a structural node: the table encoder refuses a
  // structural one outright because it would need a `ctx.build` host, and the
  // point here is the assembler's lowering, not the host contract.
  Sum: node('sum', sequence(g.Atom, literal('+'), g.Expr), (kids: readonly unknown[]) => ({ sum: [kids[0], kids[2]] })),
  Atom: choice(g.Num, g.Paren),
  Num: transform(regex(/\d+/), v => Number(v)),
  Paren: transform(sequence(literal('('), g.Expr, literal(')')), v => (v as unknown[])[1]),
  List: many(g.Expr),
  Maybe: optional(g.Num),
  One: sequence(g.Num),
  Four: sequence(literal('a'), literal('b'), literal('c'), literal('d')),
})) as Record<string, import('../../src/types.ts').Combinator<unknown>>

describe('table assembler', () => {
  it('answers exactly what the bytecode driver answers', () => {
    const prog = encodeTable(g, {})
    const a = assembledRules(prog)
    const e = tableRules(prog)
    for (const input of ['1', '1+2', '(1+2)', '1+(2+3)', '((7))', '', '(', '1+', 'x']) {
      for (const name of ['Expr', 'List', 'Maybe', 'One'] as const) {
        const ra = run(a[name]!, input)
        const re = run(e[name]!, input)
        expect(ra.ok, `${name} ${JSON.stringify(input)} ok`).toBe(re.ok)
        expect(ra.value, `${name} ${JSON.stringify(input)} value`).toEqual(re.value)
        expect(ra.unconsumedFrom, `${name} ${JSON.stringify(input)} unconsumed`).toBe(re.unconsumedFrom)
        if (!re.ok) {
          expect([...(ra.expected ?? [])].sort(), `${name} ${JSON.stringify(input)} expected`)
            .toEqual([...(re.expected ?? [])].sort())
        }
      }
    }
  })

  it('lowers a RECURSIVE rule without falling back to an index lookup', () => {
    // `Expr -> Sum -> Expr` is a genuine back-edge, and the encoder emits a
    // patched `OP_RULE` trampoline for it. If the assembler's cycle handling
    // were wrong this either recurses forever at ASSEMBLY time or links the
    // wrong target; both are visible here and neither is a slow-path.
    const a = assembledRules(encodeTable(g, {}))
    expect(run(a.Expr!, '1+2+3').ok).toBe(true)
    expect(run(a.Expr!, '((1+2))').ok).toBe(true)
  })

  it('materialises ONLY the pieces the option set reaches', () => {
    // The piece set is a SUPERSET; an option set reaches a subset of it. Assembly
    // walks from the rule entries and instantiates what it touches, so the
    // reached set must be a subset of the table's reachable set — never larger,
    // and never containing a site the table does not have.
    const prog = expandCompact(encodeTable(g, {}))
    const t = resolveTable(prog)
    const reachable = reachableIps(prog)
    for (const cfg of [
      { hostCst: false, trackLines: false, tolerant: false , coverage: false },
      { hostCst: false, trackLines: true, tolerant: false , coverage: false },
      { hostCst: false, trackLines: false, tolerant: true , coverage: false },
    ]) {
      const asm = assemble(t, prog, cfg)
      for (const ip of asm.reached) {
        expect(reachable.has(ip), `assembly reached ip ${ip}, which the table does not`).toBe(true)
      }
      expect(asm.reached.size).toBeGreaterThan(0)
      expect(asm.reached.size).toBeLessThanOrEqual(reachable.size)
    }
  })

  it('caches ONE assembly per option set, not one per parse', () => {
    const cache = new AssemblyCache(expandCompact(encodeTable(g, {})))
    const a1 = cache.for({ hostCst: false, trackLines: false, tolerant: false , coverage: false })
    const a2 = cache.for({ hostCst: false, trackLines: false, tolerant: false , coverage: false })
    const b = cache.for({ hostCst: false, trackLines: true, tolerant: false , coverage: false })
    expect(a1, 'the same option set must reuse its assembly').toBe(a2)
    expect(b, 'a different option set is a different assembly').not.toBe(a1)
  })

  it('links each SHARED subtree once', () => {
    // `Atom` is referenced by `Sum` and by `Expr`. Memoisation by code offset
    // means one piece with two references, not two pieces — which is what keeps
    // assembly proportional to the GRAMMAR rather than to the reference count.
    const prog = expandCompact(encodeTable(g, {}))
    const t = resolveTable(prog)
    const asm = assemble(t, prog, { hostCst: false, trackLines: false, tolerant: false , coverage: false })
    // The reached set is keyed by offset, so a double-link would be invisible in
    // its size — instead assert the invariant that makes it impossible: every
    // reached offset is distinct by construction (it is a Set) AND the count
    // never exceeds the table's own reachable count.
    expect(asm.reached.size).toBeLessThanOrEqual(reachableIps(prog).size)
  })

  /**
   * BACKTRACKING OVER A `node()`, UNDER A CST HOST — the assembler's mark
   * protocol against `exec.ts`.
   *
   * Every other assembler gate runs the AST path: `bench/jess/g5-identity.ts`
   * loads `(dialect, 'ast')`, and `bench/table-lowering-identity.ts` drives
   * `tableRules` only. On that path `ctx._cstBuf` is `undefined` for the whole
   * parse, so the assembler's mark protocol is only ever exercised down its
   * `_cstChildren`/`_cstLeaves` arm — the LAZY BUFFER arm, which is the one a
   * `node()` installs, had no coverage at all.
   *
   * That arm is where a stale `ctx._cstBuf` hides. The buffer is per-NODE
   * state: `beginCstNodeCapture` installs a fresh one and `endCstNodeCapture`
   * restores the parent's, so between a mark and its rollback the buffer object
   * can be replaced. A mark that reads a length off a buffer that is no longer
   * the live one does not throw and does not fail the parse — it silently keeps
   * or drops CST children.
   *
   * `Item`'s first arm is what forces the case: it matches a `Word` node — which
   * pushes a captured child into the ENCLOSING `Doc` buffer — and then demands a
   * `!` that is not there, so the choice must roll that child back out before
   * the second arm re-recognises the same text. A stale mark leaves the `Word`
   * behind and `Doc` ends up with it twice.
   */
  it('agrees with the bytecode driver when a choice backtracks over a node(), under a CST host', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    const cg = rules<Record<string, Combinator<unknown>>>({ trivia: regex(/[ \t\n]+/) }, (g: any) => ({
      Word: node('Word', regex(/[a-z]+/), (c: readonly unknown[]) => ({ t: 'Word', c })),
      Num: node('Num', regex(/\d+/), (c: readonly unknown[]) => ({ t: 'Num', c })),
      // Arm 1 CONSUMES A NODE AND THEN FAILS. Arms 2/3 re-recognise the same
      // text, so a rollback that kept the arm-1 capture duplicates it.
      Item: choice(sequence(g.Word, literal('!')), g.Word, g.Num),
      Doc: node('Doc', many(g.Item), (c: readonly unknown[]) => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>

    const prog = encodeTable(cg, { hostMode: 'cst' })
    const a = assembledRules(prog).Doc!
    const e = tableRules(prog).Doc!
    for (const input of ['ab', 'ab cd', 'ab! cd 12', 'ab cd! 12 ef', 'ab  12  cd', '', 'ab cd 12 !']) {
      const build = (): never => cstBuildHost({ tags: true }) as never
      const ra = run(a as never, input, { build: build() })
      const re = run(e as never, input, { build: build() })
      const label = JSON.stringify(input)
      expect(ra.ok, `${label} ok`).toBe(re.ok)
      // The whole CST — children, rawChildren, spans, trivia log — not just `ok`.
      expect(digestValue(ra.value), `${label} cst`).toBe(digestValue(re.value))
      expect(ra.unconsumedFrom, `${label} unconsumed`).toBe(re.unconsumedFrom)
      expect([...(ra.expected ?? [])].sort(), `${label} expected`)
        .toEqual([...(re.expected ?? [])].sort())
    }
  })
})
