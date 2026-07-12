/**
 * Incremental re-parse (`parseDoc().edit()`) on AMBIENT-TRIVIA grammars.
 *
 * The sibling oracle (`incremental.test.ts`) proves `edit() ≡ full reparse` only
 * over trivia-FREE grammars (compact, contiguous tokens). Real grammars — css,
 * less, scss, jess — declare ambient trivia with `rules({ trivia }, …)`, so
 * whitespace and comments sit BETWEEN terms and around every node. This file
 * closes that gap: the same `edit() ≡ full reparse` oracle, plus trivia-specific
 * edits a trivia-free grammar can't express (edit inside a comment / whitespace
 * run, edits that add/remove trivia, edits at a trivia-attachment boundary), all
 * asserting the incrementally-edited tree — INCLUDING trivia attribution and
 * positions — is structurally identical to a fresh full parse.
 *
 * Two things ambient trivia forces on the harness:
 *
 *  1. Trivia in the tree. `node()` records consumed trivia in a node's `triviaLog`
 *     (flat `[start,end,insertIdx]` triples), NOT in the structural `children`.
 *     To make trivia part of the oracle relation — `structurallyEqual` compares
 *     `_tag:'trivia'` children — the CST builder here interleaves each trivia run
 *     back into `children` at its recorded position. A stale or mis-positioned
 *     trivia attribution then shows up as a structural mismatch.
 *
 *  2. A COMPILED registry. `parseDoc` builds its own `ParseContext` and does not
 *     install a grammar's ambient trivia into it, so passing the raw interpreter
 *     `rules()` combinators would parse nothing past the first space. The
 *     compiled rule functions self-install their ambient trivia (it's baked into
 *     codegen), which is exactly how the real grammars are consumed via `.edit()`.
 *     Compiled functions carry no `_def`, so structural list-splice reuse
 *     (`structuralReuse`) is a no-op with them — a structural edit falls back to a
 *     full, correct reparse (see the final `describe`). The localized-reentry
 *     graft path (which slides trivia-leaf spans by `delta`) is still exercised.
 *
 * Determinism: a seeded mulberry32 PRNG; no Math.random anywhere.
 */
import { describe, it, expect } from 'vitest'
import {
  node, regex, literal, sequence, optional, sepBy, oneOrMore, trivia, rules, parseDoc, compile,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import type { Registry } from '../../src/functional/doc.ts'
import { structurallyEqual, relTreeOf } from '../../src/functional/doc.ts'
import type { CSTChild, CSTNode } from '../../src/cst/types.ts'

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const int = (r: Rng, n: number) => Math.floor(r() * n)
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, xs.length)]!

// ── CST builder: interleave trivia back into children so it's in the oracle ───
// build() receives structural `children`/`rawChildren` plus the flat `triviaLog`
// (`[start,end,insertIdx]` triples, absolute offsets, `insertIdx` = the
// rawChildren slot the trivia preceded). We splice each run in as a `trivia` leaf
// so `structurallyEqual` compares its span alongside the structural children.
function cst(type: string) {
  return (
    _children: readonly unknown[],
    _fields: unknown,
    span: { start: number; end: number },
    rawChildren: readonly unknown[],
    triviaLog: readonly number[],
    state: unknown,
  ): CSTNode => {
    const out: unknown[] = []
    let ti = 0
    for (let ci = 0; ci <= rawChildren.length; ci++) {
      while (ti < triviaLog.length && triviaLog[ti + 2] === ci) {
        out.push({ _tag: 'trivia', value: '', span: { start: triviaLog[ti]!, end: triviaLog[ti + 1]! } })
        ti += 3
      }
      if (ci < rawChildren.length) out.push(rawChildren[ci])
    }
    return { _tag: 'node', type, span: { start: span.start, end: span.end }, state, children: out as CSTChild[] }
  }
}

// ── Ambient-trivia grammar (a CSS-ish block: block / declaration / value list) ─
// trivia = a run of whitespace OR a `/* block comment */`, declared ONCE on
// rules(). Node shapes chosen so trivia sits between terms and inside/around
// nodes: Block wraps `;`-separated Decls; Decl is `ident : value`; Value is a
// whitespace-separated list of Nums (trivia BETWEEN sibling terms, no separator).
const rw = trivia(oneOrMore(regex(/[ \t\n]+|\/\*[^]*?\*\//)))
function makeGrammar(): Record<string, Combinator<unknown>> {
  return rules({ trivia: rw }, (self: any) => ({
    Block: node('Block', sequence(literal('{'), optional(sepBy(self.Decl, literal(';'))), optional(literal(';')), literal('}')), cst('Block')),
    Decl: node('Decl', sequence(self.Ident, literal(':'), self.Value), cst('Decl')),
    Value: node('Value', oneOrMore(self.Num), cst('Value')),
    Ident: node('Ident', regex(/[a-z][a-z-]*/), cst('Ident')),
    Num: node('Num', regex(/[0-9]+/), cst('Num')),
  })) as Record<string, Combinator<unknown>>
}

// Compiled registry — the ambient trivia is self-installed by the compiled rule
// functions (parseDoc does not seed it into its own ctx; see the file header).
function compiledRegistry(): Registry<CSTNode> {
  const g = makeGrammar()
  const reg: Record<string, ReturnType<typeof compile>> = {}
  for (const key of Object.keys(g)) reg[key] = compile(g[key]!)
  return reg as unknown as Registry<CSTNode>
}

// ── Oracle helpers ────────────────────────────────────────────────────────────
type Edit = { start: number; deleted: number; inserted: string }
const applyEditStr = (src: string, e: Edit) => src.slice(0, e.start) + e.inserted + src.slice(e.start + e.deleted)

const sp = (r: Rng) => pick(r, ['', ' ', '  ', '\n', ' /*c*/ ', '\t'])
function gen(r: Rng): string {
  const idents = ['color', 'margin', 'top', 'z']
  const decls: string[] = []
  const nd = 1 + int(r, 3)
  for (let i = 0; i < nd; i++) {
    const vals: string[] = []
    const nv = 1 + int(r, 3)
    for (let j = 0; j < nv; j++) vals.push(String(int(r, 100)))
    decls.push(`${sp(r)}${pick(r, idents)}${sp(r)}:${sp(r)}${vals.join(' ' + (r() < 0.3 ? sp(r) : ''))}`)
  }
  return '{' + decls.join(';') + (r() < 0.5 ? ';' : '') + sp(r) + '}'
}
function randomEdit(r: Rng, src: string): Edit {
  const start = int(r, src.length + 1)
  const deleted = int(r, Math.min(src.length - start, 5) + 1)
  const insLen = int(r, 5)
  const alphabet = pick(r, ['0123456789', 'abcd', '{};: ', '  ', ' /*x*/ ', '\n', ';', ' '])
  let inserted = ''
  for (let i = 0; i < insLen; i++) inserted += alphabet[int(r, alphabet.length)]
  return { start, deleted, inserted }
}

// Identity-sharing (a reentry reused pre-edit nodes) — index-agnostic so it sees
// reuse after a length change slid sibling positions. >0 ⟺ a reentry happened.
function collectIdentities(n: unknown, into: Set<unknown>): void {
  if (!n || typeof n !== 'object') return
  into.add(n)
  const kids = (n as { children?: readonly unknown[] }).children
  if (Array.isArray(kids)) for (const k of kids) collectIdentities(k, into)
}
function sharedByIdentity(oldTree: unknown, newTree: unknown): number {
  const old = new Set<unknown>()
  collectIdentities(oldTree, old)
  let shared = 0
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    if (old.has(n)) shared++
    const kids = (n as { children?: readonly unknown[] }).children
    if (Array.isArray(kids)) for (const k of kids) walk(k)
  }
  walk(newTree)
  return shared
}

// ── The main fuzz: `.edit()` === fresh parseDoc, structurally (trivia included) ─
describe('parseDoc().edit() — ambient-trivia correctness fuzz (oracle)', () => {
  const SEEDS = 600
  const registry = compiledRegistry()
  it(`matches full reparse across ${SEEDS} seeds (whitespace + comment trivia)`, () => {
    const r = mulberry32(0xC0FFEE)
    let mismatches = 0
    let reentries = 0
    for (let s = 0; s < SEEDS; s++) {
      const src = gen(r)
      const base = parseDoc<CSTNode>(registry, 'Block', src)
      const e = randomEdit(r, src)
      const newSrc = applyEditStr(src, e)

      const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
      const fresh = parseDoc<CSTNode>(registry, 'Block', newSrc)

      // Oracle holds even when a random edit yields invalid source: both parses
      // fail and `structurallyEqual(null, null)` is true; a one-sided failure is a
      // real mismatch and is caught.
      const ok = structurallyEqual(inc.tree, fresh.tree)
      if (!ok) {
        mismatches++
        if (mismatches <= 3) {
          // eslint-disable-next-line no-console
          console.error(`MISMATCH seed=${s}\n  src=${JSON.stringify(src)}\n  edit=${JSON.stringify(e)}\n  new=${JSON.stringify(newSrc)}`)
        }
      }
      expect(ok).toBe(true)
      if (base.tree && inc.tree && sharedByIdentity(relTreeOf(base), relTreeOf(inc)) > 0) reentries++
    }
    // eslint-disable-next-line no-console
    console.log(`[ambient-trivia] reused (reentry) on ${reentries}/${SEEDS} edits`)
    expect(mismatches).toBe(0)
  })
})

// ── Targeted trivia-specific edits (trivia-free grammars can't express these) ──
describe('parseDoc().edit() — trivia-specific edits (trivia included in the oracle)', () => {
  const registry = compiledRegistry()
  const check = (src: string, e: Edit, label: string) => {
    const base = parseDoc<CSTNode>(registry, 'Block', src)
    if (!base.tree) throw new Error(`bad fixture for ${label}: ${JSON.stringify(src)}`)
    const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
    const fresh = parseDoc<CSTNode>(registry, 'Block', applyEditStr(src, e))
    expect(fresh.tree, `fixture edit made ${label} unparseable`).toBeTruthy()
    expect(structurallyEqual(inc.tree, fresh.tree), `${label}: ${JSON.stringify({ src, e, new: applyEditStr(src, e) })}`).toBe(true)
  }

  // Edit STRICTLY WITHIN a run of trivia.
  it('inside a whitespace run', () => check('{ color  :  1 }', { start: 8, deleted: 0, inserted: ' ' }, 'in-ws'))
  it('inside a block comment', () => check('{ color : 1 /*abc*/ 2 }', { start: 15, deleted: 1, inserted: 'X' }, 'in-comment'))
  it('grows a comment', () => check('{ color : 1 /*a*/ 2 }', { start: 15, deleted: 0, inserted: 'bcde' }, 'grow-comment'))

  // Edits that ADD trivia between terms.
  it('adds whitespace between value terms', () => check('{ color : 1 2 }', { start: 11, deleted: 0, inserted: '   ' }, 'add-ws'))
  it('adds a comment between value terms', () => check('{ color : 1 2 }', { start: 11, deleted: 0, inserted: ' /*x*/' }, 'add-comment'))
  it('adds trivia at the ident/colon boundary', () => check('{ color: 1 }', { start: 7, deleted: 0, inserted: ' ' }, 'add-ws-boundary'))

  // Edits that REMOVE trivia.
  it('removes a whitespace run entirely', () => check('{ color : 1   2 }', { start: 11, deleted: 3, inserted: ' ' }, 'remove-ws'))
  it('removes a comment', () => check('{ color : 1 /*x*/ 2 }', { start: 12, deleted: 5, inserted: '' }, 'remove-comment'))
  it('removes leading whitespace before a term', () => check('{  color : 1 }', { start: 1, deleted: 2, inserted: '' }, 'remove-lead-ws'))

  // Edit at a trivia-attachment boundary (just before/after a token trivia attaches to).
  it('inserts a char just after a token (before its trailing trivia)', () => check('{ color : 1 2 }', { start: 7, deleted: 0, inserted: 's' }, 'after-token'))
  it('inserts a char just before a token (after its leading trivia)', () => check('{ color : 1 2 }', { start: 12, deleted: 0, inserted: '9' }, 'before-token'))

  // Length-changing + structural edits that shift trivia.
  it('inserts a whole spaced declaration', () => check('{ color : 1 }', { start: 11, deleted: 0, inserted: ' ; margin : 2 3' }, 'insert-decl'))
  it('deletes a whole spaced declaration', () => check('{ color : 1 ; margin : 2 3 }', { start: 11, deleted: 15, inserted: '' }, 'delete-decl'))
  it('inserts a value term (extends a whitespace-separated list)', () => check('{ margin : 1 2 }', { start: 13, deleted: 0, inserted: ' 3' }, 'extend-value'))
})

// ── Reentry reuse survives with trivia in the tree ────────────────────────────
describe('parseDoc().edit() — a localized edit reuses the tree by identity (trivia present)', () => {
  const registry = compiledRegistry()
  it('editing a digit deep inside a value reuses untouched sibling declarations', () => {
    const decls = Array.from({ length: 20 }, (_, i) => ` ${'abcd'[i % 4]!.repeat(1 + (i % 3))} : ${i} ${i + 1} `)
    const src = '{' + decls.join(';') + '}'
    const base = parseDoc<CSTNode>(registry, 'Block', src)
    expect(base.tree).toBeTruthy()
    // Change a digit in a value near the middle (delta 0 — pure in-leaf edit).
    let at = Math.floor(src.length / 2)
    while (at < src.length && !/[0-9]/.test(src[at]!)) at++
    const inc = base.edit(at, at + 1, '7')
    const fresh = parseDoc<CSTNode>(registry, 'Block', applyEditStr(src, { start: at, deleted: 1, inserted: '7' }))
    expect(structurallyEqual(inc.tree, fresh.tree)).toBe(true)
    // A reentry happened (not a full reparse): pre-edit nodes reappear by identity.
    const reused = sharedByIdentity(relTreeOf(base), relTreeOf(inc))
    // eslint-disable-next-line no-console
    console.log(`localized in-value edit reused ${reused} nodes by identity`)
    expect(reused).toBeGreaterThan(0)
  })
})

// ── Structural list edit under ambient trivia stays correct (splice falls back) ─
describe('parseDoc().edit() — structural list edit is correct under ambient trivia', () => {
  const registry = compiledRegistry()
  // With ambient trivia the structural list-splice does NOT engage: element
  // re-parse in the splice starts right after a separator, where leading trivia
  // sits, so the disturbed middle fails to tile and `.edit()` falls back to a
  // full, correct reparse. (Compiled registries carry no grammar `_def`, so
  // `structuralReuse` is a no-op regardless — this asserts the correctness that
  // survives the fallback, over a big list where a splice would otherwise fire.)
  it('front-inserting a whole declaration into a big block equals a full reparse', () => {
    const decls = Array.from({ length: 40 }, (_, i) => ` ${'abcd'[i % 4]!.repeat(1 + (i % 3))} : ${i} `)
    const big = '{' + decls.join(';') + '}'
    const at = big.indexOf(';') + 1
    const inserted = ' q : 9 ;'
    const base = parseDoc<CSTNode>(registry, 'Block', big, { structuralReuse: true })
    expect(base.tree).toBeTruthy()
    const inc = base.edit(at, at, inserted)
    const fresh = parseDoc<CSTNode>(registry, 'Block', applyEditStr(big, { start: at, deleted: 0, inserted }))
    expect(structurallyEqual(inc.tree, fresh.tree)).toBe(true)
  })
})
