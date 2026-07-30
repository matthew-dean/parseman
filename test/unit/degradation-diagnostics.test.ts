/**
 * Two silent degradations, and the channel that makes the remaining ones audible.
 *
 * 1. `confirmedBuildArity` reads the TEXT of a reducer's parameter list. Under macro
 *    compilation `buildSrc` is the source of the EXPRESSION at the `node(...)` call
 *    site, so a reducer passed as a bare identifier arrived as just its name, matched
 *    no parameter list, and failed open into all five capture tiers — silently. The
 *    runtime cost of a rule therefore depended on how its reducer was SPELLED.
 *
 * 2. The node first-set pre-guard was gated on `capturesChildren || structural`. A
 *    confirmed ZERO-arity `() =>` reducer sets `capturesChildren = false` and thereby
 *    DELETED that node's first-set gate. CST mode forces the flag true, so the loss was
 *    'ast'-only. First-set gating is the single largest measured parse lever.
 *
 * Both change emitted grammar COST, never grammar SEMANTICS — every case below asserts
 * the parse result as well as the emitted shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { analyzeMkInlineBuild } from '../../src/compiler/inline-build.ts'
import { node, sequence, literal, regex, many, choice, parser, compile, parse } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import {
  formatDegradation, formatDegradations, beginDegradationCapture, endDegradationCapture,
  recordDegradation, resolveDegradationLevel, resetDegradationMemo,
} from '../../src/compiler/degradation.ts'

type ParseFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

function macro(code: string, name: string): { fn: ParseFn; source: string; warnings: readonly string[] } {
  const result = transformMacro(code.trim(), `${name}.ts`, new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  const fnBody = result.code.replace(/\bexport\s+/g, '').replace(/\bconst\b/g, 'var') + `\nreturn ${name}`
  return { fn: new Function(fnBody)() as ParseFn, source: result.code, warnings: result.warnings }
}

// ---------------------------------------------------------------------------
// Defect 1 — bare-identifier reducers resolve to their declaration
// ---------------------------------------------------------------------------
describe('bare-identifier reducer resolves to its module-scope declaration', () => {
  const arity1 = `
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const foldOperation = children => ({ n: children.length })
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), foldOperation))
`

  it('elides raw/trivia/state capture for an arity-1 reducer passed by name', () => {
    const { fn, source } = macro(arity1, 'P')
    // Behaviour is unchanged...
    expect(fn('a b', 0, {}).value).toEqual({ n: 2 })
    // ...but the node no longer allocates the raw-children collector it never reads.
    // Before the fix `buildSrc` was the string "foldOperation", arity was unknown, and
    // every tier stayed on. `_raw` is allocated as `[]` only when raw capture is live.
    const rawAllocs = source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []
    expect(rawAllocs).toHaveLength(0)
  })

  it('resolves a `function` declaration as well as a const arrow', () => {
    const { fn, source } = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
function foldOperation(children) { return { n: children.length } }
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), foldOperation))
`, 'P')
    expect(fn('a b', 0, {}).value).toEqual({ n: 2 })
    expect(source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).toHaveLength(0)
  })

  it('keeps every tier for a full-arity reducer passed by name (no under-capture)', () => {
    const { fn } = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const full = (c, f, s, r, tl, st) => ({ n: c.length, r: r.length, tl: tl.length, st: st !== undefined })
export const P = parser({ trivia: regex(/ +/) }, node('Full', sequence(literal('a'), literal('b')), full))
`, 'P')
    const v = fn('a b', 0, {}).value as { n: number; r: number; tl: number }
    expect(v.n).toBe(2)
    expect(v.r).toBe(2)
  })

  it('resolves a `let` that is never reassigned, and declines one that is', () => {
    const ok = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
let fold = children => ({ n: children.length })
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold))
`, 'P')
    expect(ok.fn('a b', 0, {}).value).toEqual({ n: 2 })
    expect(ok.source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).toHaveLength(0)

    const reassigned = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
let fold = children => ({ n: children.length })
fold = (c, f, s, r, tl, st) => ({ n: c.length, st })
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold))
`, 'P')
    // Which function this names is not decidable, so it fails open — the one case where
    // the diagnostic is the right answer rather than a substitute for analysis.
    expect(reassigned.source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).not.toHaveLength(0)
  })

  it('follows an alias chain', () => {
    const { fn, source } = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
function base(children) { return { n: children.length } }
const mid = base
const fold = mid
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold))
`, 'P')
    expect(fn('a b', 0, {}).value).toEqual({ n: 2 })
    expect(source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).toHaveLength(0)
  })

  it('counts DEFAULT and DESTRUCTURED parameters positionally', () => {
    // `(c, f = undefined, s, r)` is arity 4 — a default does not change a positional
    // slot. The old regex rejected the whole list and fell open.
    const { source } = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const fold = (c, f = undefined, s, r) => ({ n: c.length, r: r.length })
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold))
`, 'P')
    // Arity 4 reaches rawChildren, so raw capture is LIVE...
    expect(source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).not.toHaveLength(0)
    // ...but arity 4 is below trivia (5) and state (6), so neither is captured, which is
    // only possible if the arity was actually confirmed rather than failing open.
    expect(source).toContain('_EMPTY_TL')
  })

  it('declines a REST parameter — genuinely undecidable — and says so', () => {
    const prev = process.env.PARSEMAN_DEGRADATION
    process.env.PARSEMAN_DEGRADATION = 'warn'
    try {
      const result = transformMacro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const fold = (...args) => ({ n: args.length })
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), fold))
`.trim(), 'P.ts', new Set(['parseman']))!
      expect(result.code.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).not.toHaveLength(0)
      const w = result.warnings.join('\n')
      expect(w).toContain('rest parameter')
      expect(w).toContain('buildArity')
    } finally { process.env.PARSEMAN_DEGRADATION = prev }
  })

  it('reports an import it genuinely cannot resolve', () => {
    const prev = process.env.PARSEMAN_DEGRADATION
    process.env.PARSEMAN_DEGRADATION = 'warn'
    try {
      const result = transformMacro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
import { foldOperation } from './does-not-exist.ts'
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), foldOperation))
`.trim(), 'P.ts', new Set(['parseman']))!
      expect(result.code.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).not.toHaveLength(0)
      const w = result.warnings.join('\n')
      expect(w).toContain('[parseman] degraded [build-arity-unconfirmed]')
      expect(w).toContain('node("Fold")')
      expect(w).toContain('could not be resolved')
    } finally { process.env.PARSEMAN_DEGRADATION = prev }
  })

  it('a same-name binding in an UNRELATED scope does not block resolution', () => {
    const { fn, source } = macro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const foldOperation = children => ({ n: children.length })
const other = (foldOperation) => foldOperation
const another = ({ foldOperation }) => foldOperation
const third = (x = 1, ...foldOperation) => foldOperation
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), foldOperation))
`, 'P')
    // Those bindings are in other functions' scopes and are not in scope at the call
    // site. Shadowing is decidable, so it is decided — the old "decline if the name is
    // bound more than once anywhere" rule declined perfectly ordinary code.
    expect(fn('a b', 0, {}).value).toEqual({ n: 2 })
    expect(source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).toHaveLength(0)
  })

  it('a name GENUINELY shadowed at the call site resolves to the inner binding', () => {
    const { source } = macro(`
import { literal, node, parser, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const fold = children => ({ n: children.length })
export const P = rules((fold) => ({
  Fold: node('Fold', sequence(literal('a'), literal('b')), fold),
}))
`, 'P')
    // Here `fold` at the call site is the factory's PARAMETER, not the module const.
    // A parameter is not a function declaration, so this declines — correctly, and for
    // the right reason rather than because a name appeared twice.
    expect(source.match(/_raw\d+ = _rec\d+ \? undefined : \[\]/g) ?? []).not.toHaveLength(0)
  })

  it('PARSEMAN_DEGRADATION=error turns the report into a build failure', () => {
    const prev = process.env.PARSEMAN_DEGRADATION
    process.env.PARSEMAN_DEGRADATION = 'error'
    try {
      expect(() => transformMacro(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
import { foldOperation } from './reducers.ts'
export const P = parser({ trivia: regex(/ +/) }, node('Fold', sequence(literal('a'), literal('b')), foldOperation))
`.trim(), 'P.ts', new Set(['parseman']))).toThrow(/degraded compilation path/)
    } finally { process.env.PARSEMAN_DEGRADATION = prev }
  })

  it('does not change the EMITTED builder reference — only the cost analysis', () => {
    const { source } = macro(arity1, 'P')
    // The resolved declaration source is analysis-only: the builder is still referenced
    // by name, never inlined a second time.
    expect(source).toContain('foldOperation')
    expect(source.match(/children => \(\{ n: children\.length \}\)/g) ?? []).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Defect 2 — a zero-arity reducer must not delete the node's first-set gate
// ---------------------------------------------------------------------------
describe('node first-set guard is gated on needsFirstSetGuard alone', () => {
  const nesting = node('NestingSelector', sequence(literal('&'), regex(/[a-z]+/)), () => ({ t: 'nesting' }))

  it('emits the guard for a confirmed ZERO-arity reducer', () => {
    const g = parser({ trivia: regex(/ +/) }, node('Root', many(choice(nesting, node('Other', literal('x'), c => c))), c => c))
    const src = compile(g, undefined, { gating: 'off' }).source
    // `&` is 38. Before the fix, `capturesChildren === false` deleted this guard and the
    // node was entered — allocating and swapping its CST frame — at every position.
    expect(src).toContain('=== 38')
  })

  it('does not change what the grammar accepts or produces', () => {
    const g = parser({ trivia: regex(/ +/) }, node('Root', many(choice(nesting, node('Other', literal('x'), c => c))), c => c))
    const compiled = compile(g, undefined, { gating: 'off' })
    for (const input of ['', '&ab', 'x', '&ab x', 'x &ab', '&', 'y', '&ab &cd x']) {
      expect(compiled.parse(input)).toEqual(parse(g, input))
    }
  })

  it('still omits the guard when the body has no discrete first set', () => {
    const g = parser({ trivia: regex(/ +/) }, node('Any', regex(/[\s\S]/), () => 1))
    expect(compile(g, undefined, { gating: 'off' }).source).not.toContain('codePointAt')
  })
})

// ---------------------------------------------------------------------------
// The channel itself
// ---------------------------------------------------------------------------
describe('degradation channel', () => {
  const prev = process.env.PARSEMAN_DEGRADATION
  beforeEach(() => { resetDegradationMemo() })
  afterEach(() => { process.env.PARSEMAN_DEGRADATION = prev; endDegradationCapture() })

  const sample = (n: number) => ({
    code: 'build-arity-unconfirmed' as const,
    severity: 'warn' as const,
    where: `node("R${n}")`,
    subject: 'build reducer `f`',
    fellBackTo: 'could not confirm its formal parameter list',
    otherwise: 'only the declared tiers would be captured',
  })

  it('formats one greppable line naming rule, reducer, fallback and alternative', () => {
    expect(formatDegradation(sample(1))).toBe(
      '[parseman] degraded [build-arity-unconfirmed] node("R1"): build reducer `f` — '
      + 'could not confirm its formal parameter list; otherwise only the declared tiers would be captured',
    )
  })

  it('aggregates above the detail cap instead of flooding the build', () => {
    const lines = formatDegradations(Array.from({ length: 20 }, (_, i) => sample(i)))
    expect(lines).toHaveLength(9)
    expect(lines[8]).toContain('+12 more site(s) not listed (20 total)')
  })

  it('dedupes repeat reports of the same rule+reducer', () => {
    process.env.PARSEMAN_DEGRADATION = 'warn'
    beginDegradationCapture()
    recordDegradation(sample(1))
    recordDegradation(sample(1))
    recordDegradation(sample(2))
    expect(endDegradationCapture()).toHaveLength(2)
  })

  it('records nothing when off', () => {
    process.env.PARSEMAN_DEGRADATION = 'off'
    beginDegradationCapture()
    recordDegradation(sample(1))
    expect(endDegradationCapture()).toHaveLength(0)
  })

  it('defaults to warn — the whole point is that the default was silence', () => {
    delete process.env.PARSEMAN_DEGRADATION
    expect(resolveDegradationLevel()).toBe('warn')
    process.env.PARSEMAN_DEGRADATION = 'error'
    expect(resolveDegradationLevel()).toBe('error')
    // An explicit argument wins over the env, as everywhere else in the compiler.
    expect(resolveDegradationLevel('off')).toBe('off')
  })

  it('prints (once) when no sink is open — the runtime compile() path', () => {
    process.env.PARSEMAN_DEGRADATION = 'warn'
    const seen: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation(m => { seen.push(String(m)) })
    try {
      recordDegradation(sample(7))
      recordDegradation(sample(7))
    } finally { spy.mockRestore() }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('[parseman] degraded [build-arity-unconfirmed] node("R7")')
  })
})

// ---------------------------------------------------------------------------
// Defect 3 — a near-miss on the inline-`mk` shape is a real cost, so it reports
// ---------------------------------------------------------------------------
describe('inline-mk near-misses are reported', () => {
  const prev = process.env.PARSEMAN_DEGRADATION
  afterEach(() => { process.env.PARSEMAN_DEGRADATION = prev; endDegradationCapture() })

  const nodeDef = (type: string, buildSrc: string) => {
    const n = node(type, literal('a'), () => null)
    ;(n._def as { buildSrc?: string }).buildSrc = buildSrc
    return n._def as Extract<import('../../src/index.ts').ParserDef, { tag: 'node' }>
  }

  it('matches the mk shape when params carry TypeScript annotations', () => {
    // The `\w+`-only parameter list used to reject this outright, so a `mk` reducer
    // written with annotations silently lost the inline path and paid a call per match.
    expect(analyzeMkInlineBuild(nodeDef('T', "(c: A, f: B, s: C, r: D, tl: E) => mk('T', c, r, s, tl)"))).toBe('T')
    expect(analyzeMkInlineBuild(nodeDef('T', "(c, f, s, r, tl) => mk('T', c, r, s, tl)"))).toBe('T')
  })

  it('keeps the fast path IN THE EMITTED ARTIFACT for an annotated mk reducer', () => {
    // The lesson of every defect in this file is that the source looked right and the
    // ARTIFACT was wrong, so assert on what comes out: an inlined object literal, and
    // no `_build[n](...)` call for this node.
    const mkSrc = "(c: A, f: B, s: C, r: D, tl: E) => mk('T', c, r, s, tl)"
    const n = node('T', literal('a'), () => null)
    ;(n._def as { buildSrc?: string }).buildSrc = mkSrc
    const src = compile(parser({}, n), undefined, { gating: 'off' }).source
    expect(src).toContain("_tag: 'node', type: \"T\"")
    expect(src).not.toContain('_build[0](')
  })

  it('reports a type mismatch instead of silently declining', () => {
    process.env.PARSEMAN_DEGRADATION = 'warn'
    beginDegradationCapture()
    expect(analyzeMkInlineBuild(nodeDef('T', "(c, f, s, r, tl) => mk('U', c, r, s, tl)"))).toBeNull()
    const found = endDegradationCapture()
    expect(found).toHaveLength(1)
    expect(formatDegradation(found[0]!)).toContain('[parseman] degraded [mk-inline-missed] node("T")')
    expect(formatDegradation(found[0]!)).toContain('builds a "U" node, not "T"')
  })

  it('reports a shape near-miss (wrong argument order)', () => {
    process.env.PARSEMAN_DEGRADATION = 'warn'
    beginDegradationCapture()
    expect(analyzeMkInlineBuild(nodeDef('T', "(c, f, s, r, tl) => mk('T', c, s, r, tl)"))).toBeNull()
    expect(endDegradationCapture()).toHaveLength(1)
  })

  it('says nothing about a reducer that was never an mk candidate', () => {
    process.env.PARSEMAN_DEGRADATION = 'warn'
    beginDegradationCapture()
    expect(analyzeMkInlineBuild(nodeDef('T', 'c => ({ c })'))).toBeNull()
    // Per-rule noise on every grammar that does not use the pattern would turn the
    // diagnostic back into silence, which is the failure mode being fixed.
    expect(endDegradationCapture()).toHaveLength(0)
  })

  it('declines a structural node with no build of its own', () => {
    const n = node('S', literal('a'))
    expect(analyzeMkInlineBuild(n._def as Extract<import('../../src/index.ts').ParserDef, { tag: 'node' }>)).toBeNull()
  })
})
