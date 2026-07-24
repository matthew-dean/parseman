/**
 * Ambient `scanSkip` through the `compose([...])` materialization path.
 *
 * `scanSkip` is grammar-level, declared via `rules({ scanSkip }, …)`, and makes a
 * bare `scanTo`/`balanced` skip opaque units (strings, brackets) by default so a
 * sentinel hidden inside one is never matched. The standalone `rules()` and
 * `composeLeaf([…, rules({ scanSkip })])` paths already thread it; this file covers
 * the remaining `compose([…, rules({ scanSkip })])` path.
 *
 * Unlike composing-wins `trivia`, `scanSkip` is PER-PIECE: opaque units are
 * dialect-specific, so a local rules element's own `scanSkip` must reach the
 * re-lower of THAT element's pieces — not the composing grammar's. It rides with
 * the element's carried IR as the `rules({ scanSkip }, …)` options, which stamps
 * `_meta.grammarScanSkip` when re-lowered (compileLinkable's fallback re-applies
 * it) and survives to a downstream re-compose.
 *
 * Covered: the macro build-time fuse, the runtime `compose()` fuse, IR
 * round-trip preservation, and the CONTROL (no scanSkip → sentinel matched).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as parseman from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

const COMPOSED_PIECES = Symbol.for('parseman.composedPieces')

type FusedRule = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

/** Macro-compile a module exporting `grammar`, then eval it to the live fused value. */
function buildComposed(src: string): Record<string | symbol, unknown> {
  const out = transformMacro(src, '/pkg/scan-skip-compose.ts', new Set(['parseman']))
  if (!out) throw new Error('transformMacro returned null')
  expect(out.warnings).toEqual([])
  if (out.code.includes("from 'parseman'")) throw new Error('macro did not remove the import — compile failed')
  const mod: Record<string, unknown> = {}
  const body = out.code
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/export const (\w+)/g, 'mod.$1')
  // eslint-disable-next-line no-new-func
  new Function('mod', ...Object.keys(parseman), body)(mod, ...Object.values(parseman))
  return mod as Record<string | symbol, unknown>
}

// A double-quoted string is the opaque unit; a `;` inside it must be ignored.
// `base` is a trivial recognition grammar so the composition has ≥2 elements (the
// `compose()` path, not `composeLeaf` and not a standalone `rules()`).
const MACRO_SRC = `import { rules, compose, sequence, literal, regex, scanTo } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const base = rules(g => ({ Filler: regex(/#/) }))
export const grammar = compose([
  base,
  rules({ scanSkip: [dq] }, g => ({
    entry: sequence(g.toSemi, literal(';')),
    toSemi: scanTo(literal(';')),
  })),
])`

// Identical, but the local rules declares NO scanSkip — the control.
const MACRO_SRC_BARE = `import { rules, compose, sequence, literal, regex, scanTo } from 'parseman' with { type: 'macro' }
const base = rules(g => ({ Filler: regex(/#/) }))
export const grammar = compose([
  base,
  rules(g => ({
    entry: sequence(g.toSemi, literal(';')),
    toSemi: scanTo(literal(';')),
  })),
])`

const INPUT = 'a "x;y" b;'   // the `;` inside "x;y" must be ignored
const EXPECT = 'a "x;y" b'   // scan lands at the REAL `;` after the string

describe('compose() threads a local rules({ scanSkip }) per-piece — macro', () => {
  const mod = buildComposed(MACRO_SRC)
  const grammar = mod.grammar as Record<string, FusedRule>

  it('a sentinel hidden in a string is NOT matched (the local scanSkip applies)', () => {
    const r = grammar.entry!(INPUT, 0, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })

  it('the carried IR embeds scanSkip so a downstream re-compose keeps it', () => {
    const carried = (mod.grammar as Record<symbol, unknown>)[COMPOSED_PIECES] as Array<{ ns: string; ir?: string }>
    expect(Array.isArray(carried)).toBe(true)
    const withSkip = carried.filter(p => typeof p.ir === 'string' && p.ir.includes('scanSkip'))
    // Exactly the local element carries scanSkip — per-piece, not every piece.
    expect(withSkip.length).toBe(1)
    expect(withSkip[0]!.ir).toContain('scanSkip')
  })
})

describe('compose() control — no local scanSkip → the sentinel is matched (macro)', () => {
  const mod = buildComposed(MACRO_SRC_BARE)
  const grammar = mod.grammar as Record<string, FusedRule>

  it('a `;` inside a string IS matched (nothing ambient protects it)', () => {
    const r = grammar.entry!('a "x;y";', 0, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe('a "x')   // stopped mid-string
  })

  it('the carried IR embeds NO scanSkip', () => {
    const carried = (mod.grammar as Record<symbol, unknown>)[COMPOSED_PIECES] as Array<{ ns: string; ir?: string }>
    expect(carried.some(p => typeof p.ir === 'string' && p.ir!.includes('scanSkip'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The EXPORTED FULL-PIECE FALLBACK. When `serializeRuleMap()` can't serialize a
// grammar (here: a `guard()`, which the IR has no form for but codegen compiles
// fine), the export path carries fully lowered PIECES instead of IR. Those pieces
// must still be compiled WITH the grammar's scanSkip, or a downstream compose of
// the imported grammar loses ambient skipping entirely — silently re-opening the
// raw-scan footgun. Macro-evaluated rules carry no runtime `_meta.grammarScanSkip`
// unless the evaluator stamps it, which is what makes this path easy to miss.
// ---------------------------------------------------------------------------
describe('exported FULL-PIECE fallback (IR unserializable) still carries scanSkip', () => {
  const BASE_SRC = `import { rules, sequence, literal, regex, scanTo, guard } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
export const base = rules({ scanSkip: [dq] }, g => ({
  Doc: sequence(guard(s => true), scanTo(literal(';')), literal(';')),
}))`

  const LEAF_SRC = `import { compose, rules } from 'parseman' with { type: 'macro' }
import { base } from './base.ts'
export const parser = compose([base, rules(g => ({ Top: g.Doc }))])`

  const strip = (c: string) => c
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/export const/g, 'var')
    .replace(/\bconst\b/g, 'var')

  /** Real files on disk: the downstream `import { base } from './base.ts'` is
   * resolved by the plugin's module resolver, so it must actually exist. */
  const withModules = <T>(fn: (dir: string) => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-fallback-scanskip-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}')
      fs.writeFileSync(path.join(dir, 'base.ts'), BASE_SRC)
      return fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const compileBase = (dir: string) => {
    const out = transformMacro(BASE_SRC, path.join(dir, 'base.ts'), new Set(['parseman']))
    if (!out) throw new Error('base transformMacro returned null')
    expect(out.warnings).toEqual([])
    return out
  }

  it('takes the full-piece fallback (not the IR path) — the precondition', () => {
    withModules(dir => {
      const out = compileBase(dir)
      // A carried IR entry looks like `{ ns: "…", ir: "…" }`; the fallback serializes
      // whole LinkablePieces, which have a `ruleFns` map.
      expect(out.code).toContain('ruleFns:')
      expect(/\bir:\s*"/.test(out.code)).toBe(false)
    })
  })

  it('a downstream compose of the imported grammar still skips the opaque unit', () => {
    withModules(dir => {
      const baseOut = compileBase(dir)
      const leaf = transformMacro(LEAF_SRC, path.join(dir, 'leaf.ts'), new Set(['parseman']))
      if (!leaf) throw new Error('leaf transformMacro returned null')
      expect(leaf.warnings).toEqual([])

      // eslint-disable-next-line no-new-func
      const base = new Function(`${strip(baseOut.code)}\nreturn base`)()
      // eslint-disable-next-line no-new-func
      const parser = new Function('base', `${strip(leaf.code)}\nreturn parser`)(base) as Record<string, FusedRule>

      // The `;` inside the string must be skipped, so the scan reaches the REAL `;`
      // and the rule consumes the whole input. Without scanSkip on the carried
      // pieces the scan stops at the quoted `;` (end 4).
      const input = 'a ";b" ;'
      const r = parser.Doc!(input, 0, {})
      expect(r.ok).toBe(true)
      expect(r.span.end).toBe(input.length)
    })
  })
})

describe('compose() threads a local rules({ scanSkip }) per-piece — runtime', () => {
  // The runtime `compose()` fuse (no macro): itemCarried must carry the grammar's
  // `_meta.grammarScanSkip` into the IR so materializePiece re-lowers it ambiently.
  const dq = parseman.sequence(parseman.literal('"'), parseman.regex(/[^"]*/), parseman.literal('"'))
  const base = parseman.rules(() => ({ Filler: parseman.regex(/#/) }))
  const local = parseman.rules({ scanSkip: [dq] }, (g: Record<string, parseman.Combinator<unknown>>) => ({
    entry: parseman.sequence(g.toSemi!, parseman.literal(';')),
    toSemi: parseman.scanTo(parseman.literal(';')),
  }))
  const grammar = parseman.compose([base as never, local as never]) as unknown as Record<string, FusedRule>

  it('a sentinel hidden in a string is NOT matched', () => {
    const r = grammar.entry!(INPUT, 0, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
})
