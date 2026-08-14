import { describe, expect, it } from 'vitest'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { compose, cstBuildHost } from '../../src/compiler/linker.ts'
import { FUSED_HOST_MODE } from '../../src/cst/host-mode.ts'
import { hostNodes } from '../../bench/table-grammars.ts'
import { many, node, regex, rules, sequence, type Combinator } from '../../src/index.ts'

/**
 * `encodeTable(g, { hostMode })` — the setting that had NO test at all.
 *
 * Every existing host test encodes with the DEFAULTS and supplies a host at run
 * time, which is the direction that works because `exec.ts` decides `hostCst`
 * from `ctx.build` per parse. Nothing ever encoded with `hostMode` set, so the
 * only code the setting controls — the forced capture flags in the `node` case
 * of `encode.ts` — executed on no test path, and the mismatched configuration
 * (a `'cst'` table run WITHOUT a host) had never been observed at all.
 *
 * What is asserted here is deliberately narrow and exact: the setting changes
 * the TABLE, and changes NOTHING a parse can observe. Both halves matter. If a
 * future change makes a `'cst'` table parse differently from a default one, two
 * tables of the same grammar disagree — the exact silent divergence this lane
 * exists to prevent — and the inertness assertions go red.
 */

/** Reducers of arity 1: they read no trivia, no state, no fields. */
const lowArity = rules<Record<string, Combinator<unknown>>>(g => ({
  Word: node('Word', regex(/[a-z]+/), c => ({ t: 'Word', c })),
  Doc: node('Doc', many(g.Word!), c => ({ t: 'Doc', c })),
})) as unknown as Record<string, Combinator<unknown>>

/** Reducers of full arity: the capture flags are already on by ARITY alone. */
const fullArity = rules<Record<string, Combinator<unknown>>>(g => ({
  Word: node('Word', regex(/[a-z]+/), (c, _f, _s, _r, tl, st) => ({ t: 'Word', c, tl: tl.length, st: st ?? null })),
  Doc: node('Doc', many(g.Word!), (c, _f, _s, _r, tl, st) => ({ t: 'Doc', c, tl: tl.length, st: st ?? null })),
})) as unknown as Record<string, Combinator<unknown>>

/** Every index at which two code streams differ, as `[at, plain, cst]`. */
function codeDiff(a: readonly number[], b: readonly number[]): Array<[number, number, number]> {
  expect(a.length).toBe(b.length)
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push([i, a[i]!, b[i]!])
  return out
}

describe('encodeTable({ hostMode })', () => {
  it("'cst' forces the capture flags on, and touches NOTHING else in the table", () => {
    const plain = encodeTable(lowArity)
    const cst = encodeTable(lowArity, { hostMode: 'cst' })
    const diff = codeDiff(plain.code, cst.code)
    // One flags word per node() rule, and only the flags word: same length, same
    // opcodes, same operands. Plain AST has bit 1 (`2`) because these builders
    // omit rawChildren; CST host mode clears that omission and `4|8` forces
    // capture trivia + snapshot state. An encoder
    // that also flipped, say, the project or build slot would show up here as an
    // extra differing index rather than as a passing "the tables differ".
    expect(diff.length).toBe(2)
    for (const [, before, after] of diff) {
      expect(before).toBe(2)
      expect(after).toBe(4 | 8)
    }
    // The pools are untouched — the setting is not allowed to add constants.
    expect(cst.k).toEqual(plain.k)
    expect(cst.fns.length).toBe(plain.fns.length)
    expect(cst.rules).toEqual(plain.rules)
  })

  it("'ast' is the default, byte for byte", () => {
    expect(encodeTable(lowArity, { hostMode: 'ast' }).code).toEqual(encodeTable(lowArity).code)
  })

  it('the forcing is a no-op when the reducers already asked for everything', () => {
    // The flags are derived from reducer ARITY. A full-arity reducer already has
    // them, so `hostMode: 'cst'` must produce the identical table — a setting that
    // changed the table here would be setting bits nobody derived.
    expect(encodeTable(fullArity, { hostMode: 'cst' }).code).toEqual(encodeTable(fullArity).code)
  })

  it('the mode is STAMPED on every entry and on the map, as the macro does', () => {
    // WAS: nothing stamped the mode, so `run()` read 'ast' off a 'cst' table and
    // `assertHostModeCompatible` never fired. The stamp is the whole guard.
    //
    // "A property exists" is not the assertion — the VALUE decides which pairing
    // is admitted, and a stamp put only on the map (or only on the entries) would
    // leave half the callers unguarded, so both are read.
    const cst = execRules(encodeTable(hostNodes, { hostMode: 'cst' }))
    const ast = execRules(encodeTable(hostNodes))
    expect((cst as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('cst')
    expect((cst.Doc as unknown as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('cst')
    expect((cst.Marked as unknown as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('cst')
    expect((ast as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('ast')
    expect((ast.Doc as unknown as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('ast')
    // The compiled artifact for the same grammar carries the same stamp — this
    // table is not inventing a convention of its own.
    const compiled = compose([hostNodes as never], { hostMode: 'cst' } as never) as unknown as Record<symbol, unknown>
    expect(compiled[FUSED_HOST_MODE]).toBe('cst')
  })

  it('each host mode admits exactly ONE pairing, and throws on the other', () => {
    // WAS PINNED AS: "a `cst` table run WITHOUT a host returns AST, ok:true, with
    // no signal". It now throws, and so does the mirror pairing.
    //
    // A driver that threw on every parse would satisfy the two `toThrow`s, so
    // both VALID pairings are exercised in the same test and their outputs are
    // read: the 'ast' table builds the grammar's own reducer output, the 'cst'
    // table builds host nodes.
    const cst = execRules(encodeTable(hostNodes, { hostMode: 'cst' })).Doc!
    const ast = execRules(encodeTable(hostNodes)).Doc!
    const host = cstBuildHost({ tags: true })

    expect(() => run(cst as never, 'abc')).toThrow(/host mode "cst"/)
    expect(() => run(ast as never, 'abc', { build: host as never })).toThrow(/host mode "ast"/)

    const fromAst = run(ast as never, 'abc').value as Record<string, unknown>
    expect(fromAst.t).toBe('Doc')
    expect(fromAst._tag).toBeUndefined()
    const fromCst = run(cst as never, 'abc', { build: host as never }).value as Record<string, unknown>
    expect(fromCst._tag).toBe('node')
    expect(fromCst.type).toBe('Doc')
    expect(fromCst.t).toBeUndefined()
    // The message is the engine's own, not a table-specific one: a compiled
    // artifact refuses the same pairing in the same words.
    const compiledCst = (compose([hostNodes as never], { hostMode: 'cst' } as never) as unknown as Record<string, unknown>).Doc!
    expect(() => run(compiledCst as never, 'abc')).toThrow(/host mode "cst"/)
  })

  it("rules({ hostMode: 'cst' }) selects the same mode in both lowerings", () => {
    // `rules({ hostMode })` stamps `_meta.grammarHostMode`; every lowering must
    // consume that declaration when no explicit option overrides it. Otherwise
    // the same grammar has two opposite host-admission contracts.
    const declared = rules<Record<string, Combinator<unknown>>>({ hostMode: 'cst' }, g => ({
      Word: node('Word', regex(/[a-z]+/), c => ({ t: 'Word', c })),
      Doc: node('Doc', many(g.Word!), c => ({ t: 'Doc', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    expect((declared.Doc!._meta as { grammarHostMode?: string }).grammarHostMode).toBe('cst')

    const table = execRules(encodeTable(declared))
    const compiled = compose([declared as never]) as unknown as Record<string, unknown>
    expect((table as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('cst')
    expect((compiled as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('cst')
    expect(() => run(table.Doc! as never, 'abc')).toThrow(/host mode "cst"/)
    expect(() => run(compiled.Doc as never, 'abc')).toThrow(/host mode "cst"/)

    const host = cstBuildHost({ tags: true })
    expect(run(table.Doc! as never, 'abc', { build: host as never }).ok).toBe(true)
    expect(run(compiled.Doc as never, 'abc', { build: host as never }).ok).toBe(true)

    // An explicit setting retains the same precedence compile/compose gives it.
    const explicitAst = execRules(encodeTable(declared, { hostMode: 'ast' }))
    expect((explicitAst as Record<symbol, unknown>)[FUSED_HOST_MODE]).toBe('ast')
    expect(run(explicitAst.Doc! as never, 'abc').ok).toBe(true)
  })

  it('a structural node lowers in BOTH host modes, and matches the interpreter', () => {
    // A node with no builder, no project and no collapse takes its value from a
    // `ctx.build` host. The encoder used to REFUSE it in both modes, on the
    // belief that the driver had no host — so a jess-shaped CST grammar could
    // not be lowered at all. The driver does have one: `assemble.ts` reads
    // `ctx.build` once per parse in `begin()` and bakes host-ness into which
    // pieces the assembly holds. The refusal was over-broad, not protective.
    //
    // The bar is not "it encodes" — it is that the table agrees with the
    // interpreter WITH a host and WITHOUT one, on a match and on a failure,
    // since a host that ran only at the root would pass a match-only test.
    const structural = rules<Record<string, Combinator<unknown>>>(g => ({
      S: node('S', regex(/[a-z]+/)),
      Doc: node('Doc', many(g.S!)),
    })) as unknown as Record<string, Combinator<unknown>>
    // `hostMode: 'cst'` REQUIRES a positioned-CST host — running it hostless is
    // a documented error (`assertHostModeCompatible`), not a case to compare —
    // so only `'ast'` is exercised both ways.
    const build = (type: string, children: unknown[]) => ({ H: type, n: children.length })
    for (const hostMode of ['ast', 'cst'] as const) {
      const table = execRules(encodeTable(structural, { hostMode })).Doc!
      const hosts = hostMode === 'cst'
        ? [{ build: cstBuildHost({ tags: true }) as never }]
        : [{ build } as never, {} as never]
      for (const opts of hosts) {
        for (const src of ['abc', '1', '']) {
          const t = run(table as never, src, opts as never)
          const i = run(structural.Doc as never, src, opts as never)
          expect(t.ok, `${hostMode} ${JSON.stringify(src)}`).toBe(i.ok)
          expect(t.value, `${hostMode} ${JSON.stringify(src)}`).toEqual(i.value)
        }
      }
    }
  })

  it('under a host the table yields a CST whose shape is the HOST\'s, at every level', () => {
    // The existing host tests assert the root and one child. A host that ran only
    // at the root — or only where a reducer was absent — would satisfy those.
    const host = cstBuildHost({ tags: true })
    const table = execRules(encodeTable(hostNodes, { hostMode: 'cst' })).Doc!
    const root = run(table as never, 'abc', { build: host as never }).value as Record<string, unknown>
    expect(root._tag).toBe('node')
    expect(root.type).toBe('Doc')
    expect(root.t).toBeUndefined()
    const kid = (root.children as Array<Record<string, unknown>>)[0]!
    expect(kid._tag).toBe('node')
    expect(kid.type).toBe('Marked')
    expect(kid.t).toBeUndefined()
    expect(kid.tags).toEqual(['decl'])
    const leaf = (kid.children as Array<Record<string, unknown>>)[0]!
    expect(leaf._tag).toBe('leaf')
    expect(leaf.value).toBe('abc')
  })

  it('the ctx.build host receives the SPAN and children of the node it builds', () => {
    // Recorded from the host itself, so a host called with the wrong node's span —
    // or with the parent's children — is visible. Identity against another engine
    // could not show this: both would be handed the same wrong arguments.
    const seen: Array<{ type: string; span: unknown; kids: number }> = []
    const spy = Object.assign(
      (type: string, kids: readonly unknown[], _f: unknown, span: unknown): unknown => {
        seen.push({ type, span, kids: kids.length })
        return { type, span }
      },
      { _parsemanCstOutput: true as const },
    )
    // One letter per `Word`, so 'ab' is two words and the spans are distinct.
    const g = rules<Record<string, Combinator<unknown>>>(gg => ({
      Word: node('Word', regex(/[a-z]/), c => ({ t: 'Word', c })),
      Pair: node('Pair', sequence(gg.Word!, gg.Word!), c => ({ t: 'Pair', c })),
    })) as unknown as Record<string, Combinator<unknown>>
    run(execRules(encodeTable(g, { hostMode: 'cst' })).Pair! as never, 'ab', { build: spy as never })
    expect(seen.map(s => s.type)).toEqual(['Word', 'Word', 'Pair'])
    expect(seen[0]!.span).toEqual({ start: 0, end: 1 })
    expect(seen[1]!.span).toEqual({ start: 1, end: 2 })
    expect(seen[2]!.span).toEqual({ start: 0, end: 2 })
    expect(seen[2]!.kids).toBe(2)
  })
})
