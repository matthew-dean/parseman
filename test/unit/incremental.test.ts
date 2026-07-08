/**
 * Incremental re-parse (`parseDoc().edit()`) — correctness oracle + reuse metric.
 *
 * The whole ballgame: for ANY source + ANY edit, `.edit()` must produce a tree
 * structurally identical (types, spans, leaf values) to a fresh full
 * `parseDoc()` of the edited source. We prove it with a broad deterministic fuzz
 * over several grammars, many seeds, random edits (insert / delete / replace at
 * random offsets) — plus targeted edge cases, a localized-edit reuse metric, and
 * a Stage-2 lookahead-guard stress that a bare end-offset convergence check
 * would get wrong.
 *
 * Reuse/strategy is measured HERE, externally — the runtime `.edit()` reports
 * neither (its job is to be fast, not to instrument itself). An observer derives
 * both by diffing the new tree against the previous one: nodes shared *by
 * identity* are reused, and any identity reuse at all means a reentry (a full
 * reparse builds all-fresh objects, sharing nothing).
 *
 * Grammars are trivia-free (compact, contiguous tokens) — the regime `parseDoc`
 * is built for, mirroring the compact-JSON incremental bench.
 *
 * Determinism: a seeded mulberry32 PRNG; no Math.random anywhere.
 */
import { describe, it, expect } from 'vitest'
import {
  node, regex, literal, sequence, optional, sepBy, choice, not, rules, parseDoc,
} from '../../src/index.ts'
import type { Combinator, ParseContext, ParseResult } from '../../src/index.ts'
import type { Registry, RuleFn } from '../../src/functional/doc.ts'
import { structurallyEqual } from '../../src/functional/doc.ts'
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

// ── CST builder that captures real state (for correct re-entry) ──────────────
function cst(type: string) {
  return (children: readonly unknown[], _fields: unknown, span: { start: number; end: number }, _raw: readonly unknown[], _tl: readonly number[], state: unknown): CSTNode =>
    ({ _tag: 'node', type, span: { start: span.start, end: span.end }, state, children: [...children] as CSTChild[] })
}

/** Turn a `rules()` record into a parseDoc registry keyed by node type. */
function toRegistry(g: Record<string, Combinator<unknown>>): Registry<CSTNode> {
  const reg: Record<string, RuleFn<CSTNode>> = {}
  for (const [k, comb] of Object.entries(g)) reg[k] = (i, p, c) => comb.parse(i, p, c) as ParseResult<CSTNode>
  return reg
}

// ── Reuse metric (external — the runtime does not compute this) ───────────────
function countNodes(child: unknown): number {
  const c = child as { children?: readonly unknown[] }
  let n = 1
  if (Array.isArray(c.children)) for (const g of c.children) n += countNodes(g)
  return n
}
/** Nodes shared by identity between old and new trees. >0 ⟺ a reentry happened. */
function countShared(oldTree: unknown, newTree: unknown): number {
  if (oldTree === newTree) return countNodes(newTree)
  const o = oldTree as { children?: readonly unknown[] }
  const n = newTree as { children?: readonly unknown[] }
  if (!Array.isArray(o.children) || !Array.isArray(n.children)) return 0
  let shared = 0
  for (let i = 0; i < n.children.length; i++) {
    if (o.children[i] !== undefined) shared += countShared(o.children[i], n.children[i])
  }
  return shared
}

// ── Grammars under test (trivia-free / compact) ───────────────────────────────
// Each: { registry, root, gen(rng) => valid compact source string }.

// 1. Nested bracket lists:  List = '[' (Value (',' Value)*)? ']' ,  Value = Num | List
function makeListGrammar() {
  const g = rules(self => ({
    List: node('List', sequence(literal('['), optional(sepBy(self.Value, literal(','))), literal(']')), cst('List')),
    Value: node('Value', choice(self.Num, self.List), cst('Value')),
    Num: node('Num', regex(/[0-9]+/), cst('Num')),
  }))
  function gen(r: Rng, depth = 0): string {
    const n = depth > 2 ? 0 : int(r, 3)
    const items: string[] = []
    for (let i = 0; i < n; i++) items.push(r() < 0.5 ? String(int(r, 100)) : gen(r, depth + 1))
    return '[' + items.join(',') + ']'
  }
  return { registry: toRegistry(g), root: 'List', gen: (r: Rng) => gen(r) }
}

// 2. Comma-separated key:value pairs in braces (compact JSON-ish)
function makeObjGrammar() {
  const g = rules(self => ({
    Obj: node('Obj', sequence(literal('{'), optional(sepBy(self.Pair, literal(','))), literal('}')), cst('Obj')),
    Pair: node('Pair', sequence(self.Key, literal(':'), self.Val), cst('Pair')),
    Key: node('Key', regex(/[a-z]+/), cst('Key')),
    Val: node('Val', regex(/[0-9]+/), cst('Val')),
  }))
  function gen(r: Rng): string {
    const n = int(r, 4)
    const keys = ['a', 'b', 'cc', 'ddd', 'ee']
    const ps: string[] = []
    for (let i = 0; i < n; i++) ps.push(`${pick(r, keys)}:${int(r, 1000)}`)
    return '{' + ps.join(',') + '}'
  }
  return { registry: toRegistry(g), root: 'Obj', gen }
}

// 3. Comma-separated token stream:  Seq = Term (',' Term)* ,  Term = Id | N
function makeSeqGrammar() {
  const g = rules(self => ({
    Seq: node('Seq', sepBy(self.Term, literal(',')), cst('Seq')),
    Term: node('Term', choice(self.Id, self.N), cst('Term')),
    Id: node('Id', regex(/[a-z]+/), cst('Id')),
    N: node('N', regex(/[0-9]+/), cst('N')),
  }))
  function gen(r: Rng): string {
    const n = 1 + int(r, 6)
    const toks: string[] = []
    for (let i = 0; i < n; i++) toks.push(r() < 0.5 ? pick(r, ['x', 'yy', 'foo', 'bar']) : String(int(r, 100)))
    return toks.join(',')
  }
  return { registry: toRegistry(g), root: 'Seq', gen }
}

const GRAMMARS = [makeListGrammar, makeObjGrammar, makeSeqGrammar]

// ── Oracle helpers ────────────────────────────────────────────────────────────
type Edit = { start: number; deleted: number; inserted: string }
const applyEditStr = (src: string, e: Edit) => src.slice(0, e.start) + e.inserted + src.slice(e.start + e.deleted)

function randomEdit(r: Rng, src: string): Edit {
  const start = int(r, src.length + 1)
  const maxDel = src.length - start
  const deleted = int(r, Math.min(maxDel, 4) + 1)
  const insLen = int(r, 4)
  const alphabet = pick(r, ['0123456789', 'abcde', '[](){}:,', '{}[]', ','])
  let inserted = ''
  for (let i = 0; i < insLen; i++) inserted += alphabet[int(r, alphabet.length)]
  return { start, deleted, inserted }
}

// ── The main fuzz: `.edit()` === fresh parseDoc, structurally ──────────────────
describe('parseDoc().edit() — correctness fuzz (oracle)', () => {
  const SEEDS = 400
  for (const makeG of GRAMMARS) {
    const { registry, root, gen } = makeG()
    it(`matches full reparse across ${SEEDS} seeds [${makeG.name}]`, () => {
      const r = mulberry32(0xC0FFEE ^ makeG.name.length * 2654435761)
      let reentries = 0
      let mismatches = 0
      for (let s = 0; s < SEEDS; s++) {
        const src = gen(r)
        const base = parseDoc<CSTNode>(registry, root, src)
        if (!base.tree) continue // generator should always produce valid source
        const e = randomEdit(r, src)
        const newSrc = applyEditStr(src, e)

        const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
        const fresh = parseDoc<CSTNode>(registry, root, newSrc)

        const ok = structurallyEqual(inc.tree, fresh.tree)
        if (!ok) {
          mismatches++
          if (mismatches <= 3) {
            // eslint-disable-next-line no-console
            console.error(`MISMATCH seed=${s} grammar=${makeG.name}\n  src=${JSON.stringify(src)}\n  edit=${JSON.stringify(e)}\n  new=${JSON.stringify(newSrc)}`)
          }
        }
        expect(ok).toBe(true)
        if (inc.tree && base.tree && countShared(base.tree, inc.tree) > 0) reentries++
      }
      // eslint-disable-next-line no-console
      console.log(`[${makeG.name}] reused (reentry) on ${reentries}/${SEEDS} edits`)
      expect(mismatches).toBe(0)
    })
  }
})

// ── Reuse metric on localized edits ───────────────────────────────────────────
describe('parseDoc().edit() — reuse fraction on localized edits', () => {
  it('reuses a large fraction of the tree for a deep localized edit', () => {
    const { registry, root } = makeObjGrammar()
    // A big object; replace one digit deep inside (delta 0) — most siblings must
    // be shared by reference.
    const src = '{' + Array.from({ length: 30 }, (_, i) => `${'abcde'[i % 5]}${'x'.repeat((i % 4) + 1)}:${i}`).join(',') + '}'
    const base = parseDoc<CSTNode>(registry, root, src)
    expect(base.tree).toBeTruthy()
    // Replace a digit in the ~middle value.
    let at = Math.floor(src.length / 2)
    while (at < src.length && !/[0-9]/.test(src[at]!)) at++
    const inc = base.edit(at, at + 1, '7')
    const fresh = parseDoc<CSTNode>(registry, root, applyEditStr(src, { start: at, deleted: 1, inserted: '7' }))
    expect(structurallyEqual(inc.tree, fresh.tree)).toBe(true)

    const reused = countShared(base.tree, inc.tree)
    const total = countNodes(inc.tree)
    const frac = reused / total
    // eslint-disable-next-line no-console
    console.log(`localized-edit reuse fraction = ${(frac * 100).toFixed(1)}% (${reused}/${total})`)
    expect(reused).toBeGreaterThan(0) // a reentry happened, not a full reparse
    expect(frac).toBeGreaterThan(0.6)
  })
})

// ── Localized-edit fuzz: in-value digit edits converge with high reuse ─────────
describe('parseDoc().edit() — localized-edit fuzz (reuses)', () => {
  it('digit edits inside object values reuse >50% of the tree', () => {
    const { registry, root } = makeObjGrammar()
    const r = mulberry32(0x5EED)
    let highReuse = 0
    let total = 0
    for (let s = 0; s < 300; s++) {
      const n = 2 + int(r, 6)
      const keys = ['a', 'b', 'cc', 'ddd', 'ee', 'ff']
      const ps: string[] = []
      for (let i = 0; i < n; i++) ps.push(`${keys[i % keys.length]}:${100 + int(r, 900)}`)
      const src = '{' + ps.join(',') + '}'
      const base = parseDoc<CSTNode>(registry, root, src)
      if (!base.tree) continue
      const digitPositions: number[] = []
      for (let i = 0; i < src.length; i++) if (/[0-9]/.test(src[i]!)) digitPositions.push(i)
      if (digitPositions.length === 0) continue
      const at = pick(r, digitPositions)
      total++
      const inc = base.edit(at, at + 1, String(int(r, 10))) // delta 0
      // `.edit()` sets `.input` to the edited source — parse it fresh for the oracle.
      const fresh = parseDoc<CSTNode>(registry, root, inc.input)
      expect(structurallyEqual(inc.tree, fresh.tree), `src=${src} at=${at}`).toBe(true)
      if (inc.tree && countShared(base.tree, inc.tree) / countNodes(inc.tree) > 0.5) highReuse++
    }
    // eslint-disable-next-line no-console
    console.log(`localized digit-edit: ${highReuse}/${total} reused >50% of the tree`)
    expect(highReuse).toBeGreaterThan(total * 0.8)
  })
})

// ── Targeted edge cases ───────────────────────────────────────────────────────
describe('parseDoc().edit() — edge cases', () => {
  const { registry, root } = makeObjGrammar()
  const check = (src: string, e: Edit, label: string) => {
    const base = parseDoc<CSTNode>(registry, root, src)
    if (!base.tree) throw new Error(`bad fixture for ${label}: ${src}`)
    const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
    const fresh = parseDoc<CSTNode>(registry, root, applyEditStr(src, e))
    expect(structurallyEqual(inc.tree, fresh.tree), `${label}: ${JSON.stringify({ src, e })}`).toBe(true)
  }

  it('edit at offset 0', () => check('{a:1}', { start: 0, deleted: 0, inserted: 'x' }, 'offset-0'))
  it('edit at EOF', () => check('{a:1}', { start: 5, deleted: 0, inserted: 'x' }, 'eof'))
  it('empty edit (no-op)', () => check('{a:1,b:2}', { start: 2, deleted: 0, inserted: '' }, 'empty'))
  it('edit inside a leaf (value digits)', () => check('{a:123,b:2}', { start: 4, deleted: 1, inserted: '9' }, 'in-leaf'))
  it('edit spanning a node boundary', () => check('{a:1,b:2}', { start: 3, deleted: 3, inserted: 'x:9' }, 'boundary'))
  it('structure-changing: insert a comma+pair', () => check('{a:1}', { start: 4, deleted: 0, inserted: ',z:9' }, 'insert-pair'))
  it('structure-changing: delete closing brace', () => check('{a:1}', { start: 4, deleted: 1, inserted: '' }, 'del-brace'))
  it('structure-changing: insert opening brace', () => check('{a:1}', { start: 1, deleted: 0, inserted: '{' }, 'insert-brace'))
  it('replace whole content', () => check('{a:1,b:2}', { start: 0, deleted: 9, inserted: '{z:5}' }, 'replace-all'))
  it('delete everything', () => check('{a:1}', { start: 0, deleted: 5, inserted: '' }, 'delete-all'))
})

// ── Stage-2 guard: an edit that introduces a cross-boundary lookahead ─────────
// A grammar where a token means something different depending on whether a '!'
// immediately follows it (Bang = letters+'!', else Plain = letters). A naive
// end-offset convergence would happily reuse a Plain node even after an inserted
// '!' turned it into a Bang. Tokens are space-separated via an EXPLICIT literal
// (not trivia), so the grammar stays contiguous/parseDoc-native.
describe('parseDoc().edit() — Stage-2 lookahead guard', () => {
  function makePeekGrammar() {
    const g = rules(self => ({
      Doc: node('Doc', sepBy(self.Tok, literal(' ')), cst('Doc')),
      Tok: node('Tok', choice(self.Bang, self.Plain), cst('Tok')),
      Bang: node('Bang', sequence(regex(/[a-z]+/), literal('!')), cst('Bang')),
      Plain: node('Plain', regex(/[a-z]+/), cst('Plain')),
    }))
    return { registry: toRegistry(g), root: 'Doc' }
  }

  it('inserting a lookahead-crossing char stays correct (guard falls back)', () => {
    const { registry, root } = makePeekGrammar()
    const src = 'ab cd'
    for (const e of [{ start: 2, deleted: 0, inserted: '!' }, { start: 2, deleted: 0, inserted: '! ' }] as Edit[]) {
      const base = parseDoc<CSTNode>(registry, root, src)
      const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
      const fresh = parseDoc<CSTNode>(registry, root, applyEditStr(src, e))
      expect(structurallyEqual(inc.tree, fresh.tree), JSON.stringify(e)).toBe(true)
    }
  })

  it('guard-on fuzz on the peek grammar is always correct', () => {
    const { registry, root } = makePeekGrammar()
    const r = mulberry32(0xBADF00D)
    const words = ['a', 'ab', 'abc', 'x', 'yz']
    for (let s = 0; s < 300; s++) {
      const n = 1 + int(r, 4)
      const toks: string[] = []
      for (let i = 0; i < n; i++) toks.push(pick(r, words) + (r() < 0.4 ? '!' : ''))
      const src = toks.join(' ')
      const base = parseDoc<CSTNode>(registry, root, src)
      if (!base.tree) continue
      const alpha = pick(r, ['abc', '! ', '!', ' ', 'x'])
      const start = int(r, src.length + 1)
      const inserted = alpha.slice(0, 1 + int(r, alpha.length))
      const e: Edit = { start, deleted: int(r, Math.min(src.length - start, 3) + 1), inserted }
      const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
      const fresh = parseDoc<CSTNode>(registry, root, applyEditStr(src, e))
      expect(structurallyEqual(inc.tree, fresh.tree), `src=${src} e=${JSON.stringify(e)}`).toBe(true)
    }
  })

  // A grammar whose rules read PAST their own end via an in-rule trailing
  // negative lookahead (`Bare = letters not-followed-by '='`). This is the shape
  // the Stage-2 `boundaryIsSafe` probe exists for; fuzz it and require exact
  // correctness. (Note: with the containment + end-convergence checks in place,
  // we could not construct an input where dropping the guard actually diverges —
  // reentry re-decides the enclosing choice — so the guard is conservative here
  // rather than demonstrably load-bearing.)
  function makeLookaheadGrammar() {
    const g = rules(self => ({
      Doc: node('Doc', sepBy(self.Item, literal(' ')), cst('Doc')),
      Item: node('Item', choice(self.Assign, self.Bare), cst('Item')),
      Assign: node('Assign', sequence(regex(/[a-z]+/), literal('='), regex(/[0-9]+/)), cst('Assign')),
      Bare: node('Bare', sequence(regex(/[a-z]+/), not(literal('='))), cst('Bare')),
    }))
    return { registry: toRegistry(g), root: 'Doc' }
  }

  it('guard-on fuzz on an in-rule trailing-lookahead grammar is always correct', () => {
    const { registry, root } = makeLookaheadGrammar()
    const r = mulberry32(0x1EAF)
    const words = ['a', 'ab', 'x', 'yz']
    for (let s = 0; s < 400; s++) {
      const n = 1 + int(r, 4)
      const toks: string[] = []
      for (let i = 0; i < n; i++) toks.push(pick(r, words) + (r() < 0.5 ? '=' + int(r, 100) : ''))
      const src = toks.join(' ')
      const base = parseDoc<CSTNode>(registry, root, src)
      if (!base.tree) continue
      const inserted = pick(r, ['=', '=5', 'a', ' ', ''])
      const start = int(r, src.length + 1)
      const e: Edit = { start, deleted: int(r, Math.min(src.length - start, 3) + 1), inserted }
      const inc = base.edit(e.start, e.start + e.deleted, e.inserted)
      const fresh = parseDoc<CSTNode>(registry, root, applyEditStr(src, e))
      expect(structurallyEqual(inc.tree, fresh.tree), `src=${src} e=${JSON.stringify(e)}`).toBe(true)
    }
  })
})
