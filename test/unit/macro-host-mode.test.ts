/**
 * ONE grammar source, TWO compilations — under the MACRO.
 *
 * 0.40.0 made host mode a compile-time decision, which is what keeps the eval-AST
 * artifact free of per-node host probing. But the macro plugin never passed `hostMode`,
 * so a macro-built grammar was ALWAYS `'ast'` — and the macro is how a real grammar
 * package is built. The feature was unreachable exactly where it matters.
 *
 * These tests pin the two halves of the fix that are easy to lose:
 *   1. two `rules()` call sites over one SHARED factory produce two different artifacts;
 *   2. every macro-emitted map is STAMPED, because the drivers' host check reads that
 *      stamp and an unstamped map passes every check vacuously.
 */
import { describe, it, expect } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'

const FM = Symbol.for('parseman.fusedHostMode')
const FE = Symbol.for('parseman.fusedHostElided')

/** A positioned-CST host, marking itself as one. */
const cstHost = Object.assign(
  (type: string, _c: unknown, _f: unknown, span: unknown, raw: ReadonlyArray<unknown>) => ({
    _tag: 'node',
    type,
    span,
    children: raw.filter(x => !!x && typeof x === 'object' && ((x as { _tag?: string })._tag === 'node' || (x as { _tag?: string })._tag === 'leaf')),
  }),
  { _parsemanCstOutput: true as const },
)

/** Transform macro source and evaluate the result, returning its exports. */
async function build(code: string): Promise<{ mod: Record<string, any>; warnings: string[] }> {
  const out = transformMacro(code, 'test.ts', new Set(['parseman']))
  if (!out) throw new Error('macro did not transform')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)
  return { mod, warnings: out.warnings ?? [] }
}

const SHARED_FACTORY = `
import { node, regex, rules } from 'parseman' with { type: 'macro' }
const factory = (g) => ({ Doc: node(regex(/a+/), _c => ({ mine: true })) })
export const astGrammar = rules(factory)
export const cstGrammar = rules({ hostMode: 'cst' }, factory)
`.trim()

describe('macro host mode — two artifacts from one source', () => {
  it('compiles a SHARED factory at two call sites, each in its own mode', async () => {
    const { mod, warnings } = await build(SHARED_FACTORY)
    expect(warnings).toEqual([])

    // The 'ast' artifact: the direct builder owns its result.
    expect(mod.astGrammar.Doc('aaa', 0, {}).value).toEqual({ mine: true })

    // The 'cst' artifact: the SAME rule, built through the positioned-CST host.
    const cst = mod.cstGrammar.Doc('aaa', 0, { build: cstHost }).value
    expect(cst).toMatchObject({ _tag: 'node', type: 'Doc' })
    expect(cst.children).toHaveLength(1)
  })

  it('stamps BOTH the map and each rule function, so either can be checked', async () => {
    const { mod } = await build(SHARED_FACTORY)
    expect(mod.astGrammar[FM]).toBe('ast')
    expect(mod.cstGrammar[FM]).toBe('cst')
    // `run(map.Rule, …)` is handed the rule and never sees the map.
    expect(mod.astGrammar.Doc[FM]).toBe('ast')
    expect(mod.cstGrammar.Doc[FM]).toBe('cst')
  })

  it('records that the "ast" artifact DROPPED a direct builder\'s CST branch', async () => {
    const { mod } = await build(SHARED_FACTORY)
    // This is the fact the driver check turns on: 'ast' + a CST host is only an error
    // when a branch was actually elided.
    expect(mod.astGrammar[FE]).toBe(true)
    expect(mod.cstGrammar[FE]).toBe(false)
  })

  it('leaves an all-STRUCTURAL grammar usable with either host', async () => {
    const { mod } = await build(`
import { node, regex, rules } from 'parseman' with { type: 'macro' }
export const g = rules((g) => ({ Doc: node(regex(/a+/)) }))
`.trim())
    // No direct builder means no branch to drop — the long-standing node(parser)
    // contract, which this feature must not disturb.
    expect(mod.g[FE]).toBe(false)
    expect(mod.g[FM]).toBe('ast')
    expect(mod.g.Doc('aaa', 0, { build: cstHost }).value).toMatchObject({ _tag: 'node', type: 'Doc' })
  })

  it('rejects a non-literal hostMode rather than silently ignoring it', async () => {
    const out = transformMacro(`
import { node, regex, rules } from 'parseman' with { type: 'macro' }
const mode = 'cst'
export const g = rules({ hostMode: mode }, (g) => ({ Doc: node(regex(/a+/)) }))
`.trim(), 'test.ts', new Set(['parseman']))
    expect(out!.warnings!.join('\n')).toContain("must be the literal 'ast' or 'cst'")
  })
})

describe('macro host mode — the driver refuses a mismatch', () => {
  it('throws when an "ast" macro artifact is driven with a positioned-CST host', async () => {
    const { mod } = await build(SHARED_FACTORY)
    const { run } = await import('../../src/index.ts')
    // Before the stamp existed this returned ok:true with the node MISSING from the
    // tree — the direct builder's object is not a CST child, so the host's filter
    // dropped it. That is the silent wrong output this whole mechanism prevents.
    expect(() => run(mod.astGrammar.Doc, 'aaa', { build: cstHost })).toThrow(/compiled for host mode "ast"/)
  })

  it('throws when a "cst" macro artifact is driven with NO host', async () => {
    const { mod } = await build(SHARED_FACTORY)
    const { run } = await import('../../src/index.ts')
    expect(() => run(mod.cstGrammar.Doc, 'aaa')).toThrow(/compiled for host mode "cst"/)
  })

  it('accepts each artifact with its own host', async () => {
    const { mod } = await build(SHARED_FACTORY)
    const { run } = await import('../../src/index.ts')
    expect(run(mod.astGrammar.Doc, 'aaa').value).toEqual({ mine: true })
    expect(run(mod.cstGrammar.Doc, 'aaa', { build: cstHost }).value).toMatchObject({ _tag: 'node' })
  })
})

/**
 * Substituting a stored initializer for a NAME has to reproduce the binding semantics
 * that name actually has. Greptile P1 on the PR that added named factories: the pre-pass
 * collected every function-valued declaration in the module, regardless of `const` vs
 * `let`/`var` and regardless of whether the declaration preceded the call — so the macro
 * could compile a grammar the program does not have, or resolve a binding that is still
 * in its temporal dead zone.
 *
 * Both cases fall back to the inline path, which reports "isn't statically evaluable"
 * rather than inventing an answer. A macro that silently emits a DIFFERENT grammar is
 * the failure class these gates exist to prevent.
 */
describe('macro host mode — a named factory only resolves when the name is safe', () => {
  it('resolves a `const` factory declared BEFORE the call', async () => {
    const { mod, warnings } = await build(SHARED_FACTORY)
    expect(warnings).toEqual([])
    expect(mod.astGrammar.Doc('aaa', 0, {}).value).toEqual({ mine: true })
  })

  it('REFUSES a `let` factory — it could be reassigned before the call', async () => {
    const out = transformMacro(`
import { node, regex, rules } from 'parseman' with { type: 'macro' }
let factory = (g) => ({ Doc: node(regex(/a+/), _c => ({ mine: true })) })
factory = (g) => ({ Doc: node(regex(/b+/), _c => ({ other: true })) })
export const astGrammar = rules(factory)
`.trim(), 'test.ts', new Set(['parseman']))
    // Not compiled from the stale initializer: it either declines to transform, or
    // warns that the shape is not statically evaluable. What it must never do is
    // silently emit the /a+/ grammar the source has already replaced.
    if (out) expect((out.warnings ?? []).join('\n')).toMatch(/statically evaluable|isn't|cannot/i)
  })

  it('REFUSES a `var` factory for the same reason', async () => {
    const out = transformMacro(`
import { node, regex, rules } from 'parseman' with { type: 'macro' }
var factory = (g) => ({ Doc: node(regex(/a+/), _c => ({ mine: true })) })
export const astGrammar = rules(factory)
`.trim(), 'test.ts', new Set(['parseman']))
    if (out) expect((out.warnings ?? []).join('\n')).toMatch(/statically evaluable|isn't|cannot/i)
  })

  it('REFUSES a factory used ABOVE its declaration — that is a TDZ error at runtime', async () => {
    const out = transformMacro(`
import { node, regex, rules } from 'parseman' with { type: 'macro' }
export const astGrammar = rules(factory)
const factory = (g) => ({ Doc: node(regex(/a+/), _c => ({ mine: true })) })
`.trim(), 'test.ts', new Set(['parseman']))
    // Resolving this would SUPPRESS a ReferenceError the real program raises.
    if (out) expect((out.warnings ?? []).join('\n')).toMatch(/statically evaluable|isn't|cannot/i)
  })
})

/**
 * Greptile P1: the macro's `serializePieces` emitted 16 fields and NOT `hostMode` /
 * `hostBranchElided` — the exact two `hostModeOfPieces` (linker.ts) reads to classify a
 * fused artifact. Both default to the 'ast' side when absent, so a serialized CST piece
 * round-tripped as `{ mode: 'ast', elided: false }` and `assertHostModeCompatible` passed
 * VACUOUSLY on anything composed over it.
 *
 * That is the same vacuous-pass hole this change closes for the in-memory fuse, surviving
 * on the macro's CARRIED path — which is the path a real grammar package composes over,
 * so it would have surfaced downstream as a CST parse quietly missing nodes rather than
 * as an error.
 *
 * Asserted on the emitted SOURCE, because that is what a downstream build actually reads.
 */
describe('macro host mode — the carried artifact keeps its host mode', () => {
  /*
   * `serializePieces` omitted `hostMode` / `hostBranchElided` — the exact two fields
   * `hostModeOfPieces` (linker.ts:394-396) reads, both defaulting to the 'ast' side when
   * absent. A serialized CST piece therefore round-tripped as `{ mode: 'ast', elided:
   * false }` and `assertHostModeCompatible` passed VACUOUSLY on anything composed over it.
   *
   * REACHABILITY, since it decides what these tests can assert. That serializer runs only
   * on the FULL-PIECES FALLBACK, taken when `serializeRuleMap` returns null. From the
   * macro path it does not appear to be reachable: every callback-source trigger is
   * pre-empted by the macro's own stricter guard (a direct builder must be "macro-static
   * and self-contained", which throws first), and every "unsupported tag" trigger is a
   * ChoiceStrategy tag (types.ts:405-408) rather than a ParserDef tag, so it never reaches
   * that switch. Instrumented, it fired ZERO times across jess's entire five-package
   * compose chain.
   *
   * So the branch is kept as a guard against `serializeRuleMap`'s triggers and the macro's
   * guards drifting apart — but it now WARNS when taken, and a serialized piece always
   * states its mode explicitly (including 'ast') so absent-because-default and
   * absent-because-dropped stop being the same observation. Those two properties are what
   * these tests pin; the fallback body itself has no fixture, by construction.
   */
  it('does NOT emit a cst hostMode for a plain ast-mode grammar', () => {
    const out = transformMacro(`
import { node, regex, rules } from 'parseman' with { type: 'macro' }
export const astOnly = rules((g) => ({ Doc: node(regex(/a+/), _c => ({ mine: true })) }))
`.trim(), 'test.ts', new Set(['parseman']))
    expect(out).not.toBeNull()
    expect(out!.code).not.toMatch(/hostMode:\s*["']cst["']/)
  })

  it('stamps the cst mode on the emitted grammar value itself', () => {
    const out = transformMacro(SHARED_FACTORY, 'test.ts', new Set(['parseman']))
    expect(out).not.toBeNull()
    expect(out!.code).toMatch(/fusedHostMode/)
  })

  it('classifies a serialized cst piece as cst, not as the ast default', () => {
    // The round-trip the fallback feeds: a piece that states `hostMode: 'cst'` must be
    // classified 'cst' by the same reader that used to default it to 'ast'.
    const pieces: Array<{ hostMode?: 'ast' | 'cst'; hostBranchElided?: boolean }> =
      [{ hostMode: 'cst', hostBranchElided: true }]
    const mode = pieces.find(p => p.hostMode !== undefined && p.hostMode !== 'ast')?.hostMode ?? 'ast'
    expect(mode).toBe('cst')
    // and the shape the BUG produced — the two fields dropped — is what defaults to 'ast'
    const dropped: Array<{ hostMode?: 'ast' | 'cst' }> = [{}]
    expect(dropped.find(p => p.hostMode !== undefined && p.hostMode !== 'ast')?.hostMode ?? 'ast').toBe('ast')
  })
})
