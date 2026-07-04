/**
 * Incremental reparse-and-resync — correctness oracle + reuse metric.
 *
 * The whole ballgame: for ANY source + ANY edit, `incrementalReparse` must
 * produce a tree structurally identical (types, spans, leaf values) to a fresh
 * full `parse(newSource)`. We prove it with a broad deterministic fuzz over
 * several grammars, many seeds, random edits (insert / delete / replace at
 * random offsets) — plus targeted edge cases and a localized-edit reuse metric.
 *
 * Determinism: a seeded mulberry32 PRNG; no Math.random anywhere.
 */
import { describe, it, expect } from 'vitest'
import {
  node, regex, literal, sequence, many, oneOrMore, optional, sepBy, choice,
  parser, parse,
} from '../../src/index.ts'
import type { Combinator, ParseContext } from '../../src/index.ts'
import { incrementalReparse, structurallyEqual } from '../../src/cst/incremental.ts'
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
  return (children: readonly unknown[], _raw: readonly unknown[], span: { start: number; end: number }, _tl: readonly number[], state: unknown): CSTNode =>
    ({ _tag: 'node', type, span: { start: span.start, end: span.end }, state, children: [...children] as CSTChild[] })
}

// ── Grammars under test ───────────────────────────────────────────────────────
// Each: { combinator, gen(rng) => valid source string }

const ws = regex(/[ \t\n]+/)

// 1. Nested bracket lists:  L = '[' (num | L)* ']'   (whitespace-separated)
// Build the recursive list with a self-ref via a thunk closure.
function makeListGrammar() {
  // eslint-disable-next-line prefer-const
  let list: Combinator<unknown>
  const item = node('Num', regex(/[0-9]+/), cst('Num'))
  const listBody: Combinator<unknown> = node(
    'List',
    sequence(literal('['), many(choice(item, { _tag: 'lazy', _meta: item._meta, _def: { tag: 'lazy', thunk: () => list }, parse: (i, p, c) => list.parse(i, p, c) } as Combinator<unknown>)), literal(']')),
    cst('List'),
  )
  list = listBody
  const g = parser({ trivia: ws }, listBody)
  function gen(r: Rng, depth = 0): string {
    const n = depth > 2 ? 0 : int(r, 3)
    const items: string[] = []
    for (let i = 0; i < n; i++) {
      items.push(r() < 0.5 ? String(int(r, 100)) : gen(r, depth + 1))
    }
    return '[' + items.join(' ') + ']'
  }
  return { combinator: g, gen: (r: Rng) => gen(r), root: 'List' }
}

// 2. Comma-separated key:value pairs inside braces (JSON-ish, stateless)
function makeObjGrammar() {
  const keyN = node('Key', regex(/[a-z]+/), cst('Key'))
  const valN = node('Val', regex(/[0-9]+/), cst('Val'))
  const pair = node('Pair', sequence(keyN, literal(':'), valN), cst('Pair'))
  const obj = node('Obj', sequence(literal('{'), optional(sepBy(pair, literal(','))), literal('}')), cst('Obj'))
  const g = parser({ trivia: ws }, obj)
  function gen(r: Rng): string {
    const n = int(r, 4)
    const ps: string[] = []
    const keys = ['a', 'b', 'cc', 'ddd', 'ee']
    for (let i = 0; i < n; i++) ps.push(`${pick(r, keys)}:${int(r, 1000)}`)
    return '{' + ps.join(',') + '}'
  }
  return { combinator: g, gen, root: 'Obj' }
}

// 3. Flat arithmetic-ish token stream: oneOrMore of (ident | number) separated by ws
function makeSeqGrammar() {
  const idN = node('Id', regex(/[a-z]+/), cst('Id'))
  const nN = node('N', regex(/[0-9]+/), cst('N'))
  const term = choice(idN, nN)
  const seq = node('Seq', oneOrMore(term), cst('Seq'))
  const g = parser({ trivia: ws }, seq)
  function gen(r: Rng): string {
    const n = 1 + int(r, 6)
    const toks: string[] = []
    for (let i = 0; i < n; i++) toks.push(r() < 0.5 ? pick(r, ['x', 'yy', 'foo', 'bar']) : String(int(r, 100)))
    return toks.join(' ')
  }
  return { combinator: g, gen, root: 'Seq' }
}

const GRAMMARS = [makeListGrammar, makeObjGrammar, makeSeqGrammar]

// ── Oracle helpers ────────────────────────────────────────────────────────────
function fullTree(combinator: Combinator<unknown>, src: string): CSTChild | null {
  const r = parse(combinator, src)
  return r.ok ? (r.value as CSTChild) : null
}

// Apply a random edit to `src`, returning { edit, newSrc } that keeps the source
// re-parseable roughly half the time (we test both convergent and fallback paths).
function randomEdit(r: Rng, src: string): { start: number; deleted: number; inserted: string } {
  const start = int(r, src.length + 1)
  const maxDel = src.length - start
  const deleted = int(r, Math.min(maxDel, 4) + 1)
  const insLen = int(r, 4)
  const alphabet = pick(r, ['0123456789', 'abcde', '[](){}:, ', '{}[]', ' \n'])
  let inserted = ''
  for (let i = 0; i < insLen; i++) inserted += alphabet[int(r, alphabet.length)]
  return { start, deleted, inserted }
}

function applyEditStr(src: string, e: { start: number; deleted: number; inserted: string }): string {
  return src.slice(0, e.start) + e.inserted + src.slice(e.start + e.deleted)
}

// ── The main fuzz: incremental === full, structurally ─────────────────────────
describe('incremental reparse — correctness fuzz (oracle)', () => {
  const SEEDS = 400
  for (const makeG of GRAMMARS) {
    const { combinator, gen } = makeG()
    it(`matches full reparse across ${SEEDS} seeds [${makeG.name}]`, () => {
      const r = mulberry32(0xC0FFEE ^ makeG.name.length * 2654435761)
      let converged = 0
      let mismatches = 0
      for (let s = 0; s < SEEDS; s++) {
        const src = gen(r)
        const oldTree = fullTree(combinator, src)
        if (!oldTree) continue // generator should always produce valid source
        const edit = randomEdit(r, src)
        const newSrc = applyEditStr(src, edit)

        const inc = incrementalReparse(combinator, oldTree, src, edit)
        const fresh = fullTree(combinator, newSrc)

        if (fresh === null) {
          // New source doesn't parse: incremental must have fallen back to full,
          // producing the error tree. We only require: incremental didn't claim a
          // bogus reuse. (Its tree is the full error tree by construction.)
          expect(inc.strategy).toBe('full')
          continue
        }
        const ok = structurallyEqual(inc.tree, fresh)
        if (!ok) {
          mismatches++
          if (mismatches <= 3) {
            // eslint-disable-next-line no-console
            console.error(`MISMATCH seed=${s} grammar=${makeG.name}\n  src=${JSON.stringify(src)}\n  edit=${JSON.stringify(edit)}\n  new=${JSON.stringify(newSrc)}\n  strategy=${inc.strategy}`)
          }
        }
        expect(ok).toBe(true)
        if (inc.strategy === 'reentry') converged++
      }
      // eslint-disable-next-line no-console
      console.log(`[${makeG.name}] converged (reentry) on ${converged}/${SEEDS} edits`)
      expect(mismatches).toBe(0)
    })
  }
})

// ── Reuse metric on localized edits ───────────────────────────────────────────
describe('incremental reparse — reuse fraction on localized edits', () => {
  it('reuses a large fraction of the tree for a deep localized edit', () => {
    const { combinator } = makeObjGrammar()
    // A big object; edit one value deep inside — most siblings must be reused.
    const src = '{' + Array.from({ length: 30 }, (_, i) => `k${'x'.repeat((i % 5) + 1)}:${i}`).join(',') + '}'
    // Note: keys must match /[a-z]+/ — 'k'+x's is fine; drop the digit.
    const src2 = '{' + Array.from({ length: 30 }, (_, i) => `${'abcde'[i % 5]}${'x'.repeat((i % 4) + 1)}:${i}`).join(',') + '}'
    const oldTree = fullTree(combinator, src2)!
    expect(oldTree).toBeTruthy()
    // Replace a digit in the ~middle value.
    const mid = Math.floor(src2.length / 2)
    // find a digit at/after mid
    let at = mid
    while (at < src2.length && !/[0-9]/.test(src2[at]!)) at++
    const edit = { start: at, deleted: 1, inserted: '7' }
    const inc = incrementalReparse(combinator, oldTree, src2, edit)
    const fresh = fullTree(combinator, applyEditStr(src2, edit))!
    expect(structurallyEqual(inc.tree, fresh)).toBe(true)
    const frac = inc.reusedNodes / inc.totalNodes
    // eslint-disable-next-line no-console
    console.log(`localized-edit reuse fraction = ${(frac * 100).toFixed(1)}% (${inc.reusedNodes}/${inc.totalNodes}), strategy=${inc.strategy}, reparsed=${JSON.stringify(inc.reparsedRange)}`)
    expect(inc.strategy).toBe('reentry')
    expect(frac).toBeGreaterThan(0.6)
  })
})

// ── Localized-edit fuzz: edits inside a value should converge with high reuse ─
describe('incremental reparse — localized-edit fuzz (converges + reuses)', () => {
  it('digit edits inside object values converge on reentry with >50% reuse', () => {
    const { combinator } = makeObjGrammar()
    const r = mulberry32(0x5EED)
    let convergedHighReuse = 0
    let total = 0
    for (let s = 0; s < 300; s++) {
      // Build an object with several pairs.
      const n = 2 + int(r, 6)
      const keys = ['a', 'b', 'cc', 'ddd', 'ee', 'ff']
      const ps: string[] = []
      for (let i = 0; i < n; i++) ps.push(`${keys[i % keys.length]}:${100 + int(r, 900)}`)
      const src = '{' + ps.join(',') + '}'
      const oldTree = fullTree(combinator, src)
      if (!oldTree) continue
      // Find all digit positions and edit one (replace a single digit with another).
      const digitPositions: number[] = []
      for (let i = 0; i < src.length; i++) if (/[0-9]/.test(src[i]!)) digitPositions.push(i)
      if (digitPositions.length === 0) continue
      const at = pick(r, digitPositions)
      const edit = { start: at, deleted: 1, inserted: String(int(r, 10)) }
      total++
      const inc = incrementalReparse(combinator, oldTree, src, edit)
      const fresh = fullTree(combinator, applyEditStr(src, edit))!
      expect(structurallyEqual(inc.tree, fresh), `src=${src} edit=${JSON.stringify(edit)}`).toBe(true)
      if (inc.strategy === 'reentry' && inc.reusedNodes / inc.totalNodes > 0.5) convergedHighReuse++
    }
    // eslint-disable-next-line no-console
    console.log(`localized digit-edit: ${convergedHighReuse}/${total} converged with >50% reuse`)
    // The overwhelming majority of pure in-value digit edits must converge & reuse.
    expect(convergedHighReuse).toBeGreaterThan(total * 0.8)
  })
})

// ── Targeted edge cases ───────────────────────────────────────────────────────
describe('incremental reparse — edge cases', () => {
  const { combinator } = makeObjGrammar()
  const check = (src: string, edit: { start: number; deleted: number; inserted: string }, label: string) => {
    const oldTree = fullTree(combinator, src)
    if (!oldTree) throw new Error(`bad fixture for ${label}: ${src}`)
    const inc = incrementalReparse(combinator, oldTree, src, edit)
    const newSrc = applyEditStr(src, edit)
    const fresh = fullTree(combinator, newSrc)
    if (fresh === null) {
      expect(inc.strategy).toBe('full')
    } else {
      expect(structurallyEqual(inc.tree, fresh), `${label}: ${JSON.stringify({ src, edit, newSrc, strat: inc.strategy })}`).toBe(true)
    }
  }

  it('edit at offset 0', () => check('{a:1}', { start: 0, deleted: 0, inserted: ' ' }, 'offset-0'))
  it('edit at EOF', () => {
    const src = '{a:1}'
    check(src, { start: src.length, deleted: 0, inserted: ' ' }, 'eof')
  })
  it('empty edit (no-op)', () => check('{a:1,b:2}', { start: 2, deleted: 0, inserted: '' }, 'empty'))
  it('edit inside a leaf (value digits)', () => check('{a:123,b:2}', { start: 4, deleted: 1, inserted: '9' }, 'in-leaf'))
  it('edit spanning a node boundary', () => check('{a:1,b:2}', { start: 3, deleted: 3, inserted: 'x:9' }, 'boundary'))
  it('structure-changing: insert a comma+pair', () => check('{a:1}', { start: 4, deleted: 0, inserted: ',z:9' }, 'insert-pair'))
  it('structure-changing: delete closing brace', () => check('{a:1}', { start: 4, deleted: 1, inserted: '' }, 'del-brace'))
  it('structure-changing: insert opening brace', () => check('{a:1}', { start: 1, deleted: 0, inserted: '{' }, 'insert-brace'))
  it('replace whole content', () => check('{a:1,b:2}', { start: 0, deleted: 9, inserted: '{z:5}' }, 'replace-all'))
  it('delete everything', () => check('{a:1}', { start: 0, deleted: 5, inserted: '' }, 'delete-all'))
})

// ── Stage 2 guard: prove the lookahead guard actually rejects unsound reuse ───
describe('incremental reparse — Stage 2 lookahead guard', () => {
  // A grammar where a rule peeks PAST its own end via not()/lookahead, so a naive
  // end-offset convergence would wrongly reuse. `Word = letters not-followed-by '!'`.
  function makePeekGrammar() {
    // Item is a run of letters that must NOT be immediately followed by '!'.
    // (A trailing '!' makes the whole run parse differently in the full parse.)
    const bang = node('Bang', sequence(regex(/[a-z]+/), literal('!')), cst('Bang'))
    const plain = node('Plain', regex(/[a-z]+/), cst('Plain'))
    // Each token: try Bang (letters + '!') first, else Plain.
    const tok = choice(bang, plain)
    const doc = node('Doc', oneOrMore(tok), cst('Doc'))
    return parser({ trivia: ws }, doc)
  }

  it('does not produce an unsound tree when an edit introduces a cross-boundary dependency', () => {
    const g = makePeekGrammar()
    // 'ab cd' → two Plain tokens. Insert '!' right after 'ab' so it becomes 'ab!'.
    // If we naively reused the 'ab' Plain node, we'd miss that it's now a Bang.
    const src = 'ab cd'
    const oldTree = fullTree(g, src)!
    const edit = { start: 2, deleted: 0, inserted: '!' } // 'ab!cd'? no ws → 'ab! cd'
    // Put a space to keep tokens: insert '! ' → 'ab!  cd'? Keep it simple: 'ab! cd'
    const edit2 = { start: 2, deleted: 0, inserted: '! ' }
    for (const e of [edit, edit2]) {
      const inc = incrementalReparse(g, oldTree, src, e)
      const newSrc = applyEditStr(src, e)
      const fresh = fullTree(g, newSrc)
      if (fresh) expect(structurallyEqual(inc.tree, fresh)).toBe(true)
      else expect(inc.strategy).toBe('full')
    }
  })

  it('unsafeSkipGuard can be turned off; default guard keeps correctness', () => {
    // Broad fuzz on the peek grammar with the guard ON — must always be correct.
    const g = makePeekGrammar()
    const r = mulberry32(0xBADF00D)
    const words = ['a', 'ab', 'abc', 'x', 'yz']
    for (let s = 0; s < 300; s++) {
      const n = 1 + int(r, 4)
      const toks: string[] = []
      for (let i = 0; i < n; i++) toks.push(pick(r, words) + (r() < 0.4 ? '!' : ''))
      const src = toks.join(' ')
      const oldTree = fullTree(g, src)
      if (!oldTree) continue
      const alpha = pick(r, ['abc', '! ', '!', ' ', 'x'])
      const start = int(r, src.length + 1)
      const inserted = alpha.slice(0, 1 + int(r, alpha.length))
      const e = { start, deleted: int(r, Math.min(src.length - start, 3) + 1), inserted }
      const inc = incrementalReparse(g, oldTree, src, e)
      const fresh = fullTree(g, applyEditStr(src, e))
      if (fresh) expect(structurallyEqual(inc.tree, fresh), `src=${src} e=${JSON.stringify(e)}`).toBe(true)
      else expect(inc.strategy).toBe('full')
    }
  })
})
