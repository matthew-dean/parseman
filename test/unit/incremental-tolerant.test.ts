/**
 * Tolerant incremental re-parse — the editor-backend fusion.
 *
 * `parseDoc(..., { tolerant: true })` keeps producing a tree through broken input
 * (recovery), and — the point of this file — embeds the recovered error as a
 * `parseError` CST child at the recovery point, so the error rides inside the tree
 * and survives incremental reuse. Two guarantees:
 *
 *   1. A broken element becomes a `parseError` node in `children`, spanning exactly
 *      the skipped text (not just a side-channel entry).
 *   2. The tolerant oracle: `.edit()` === a fresh full tolerant `parseDoc` of the
 *      edited text, structurally — including the embedded error nodes — across a
 *      randomized fuzz whose edits routinely break structure.
 */
import { describe, it, expect } from 'vitest'
import { node, regex, literal, sequence, optional, sepBy, choice, rules, parseDoc } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import type { Registry } from '../../src/functional/doc.ts'
import { structurallyEqual } from '../../src/functional/doc.ts'
import type { CSTChild, CSTNode } from '../../src/cst/types.ts'

function cst(type: string) {
  return (children: readonly unknown[], _f: unknown, span: { start: number; end: number }, _r: readonly unknown[], _t: readonly number[], state: unknown): CSTNode =>
    ({ _tag: 'node', type, span: { start: span.start, end: span.end }, state, children: [...children] as CSTChild[] })
}
const reg = <T,>(g: Record<string, Combinator<unknown>>) => g as unknown as Registry<T>

// ── grammars (genuine repetitions, so structural reuse is sound) ──────────────
function listGrammar() {
  const g = rules(self => ({
    List: node('List', sequence(literal('['), optional(sepBy(self.Value, literal(','))), literal(']')), cst('List')),
    Value: node('Value', choice(self.Num, self.List), cst('Value')),
    Num: node('Num', regex(/[0-9]+/), cst('Num')),
  }))
  return { registry: reg<CSTNode>(g), root: 'List' }
}
function seqGrammar() {
  const g = rules(self => ({
    Seq: node('Seq', sepBy(self.Term, literal(',')), cst('Seq')),
    Term: node('Term', choice(self.Id, self.N), cst('Term')),
    Id: node('Id', regex(/[a-z]+/), cst('Id')),
    N: node('N', regex(/[0-9]+/), cst('N')),
  }))
  return { registry: reg<CSTNode>(g), root: 'Seq' }
}

// deepest error nodes anywhere in a tree
function errorsOf(n: unknown, out: Array<{ start: number; end: number }> = []): typeof out {
  const c = n as { _tag?: string; span?: { start: number; end: number }; children?: readonly unknown[] }
  if (c?._tag === 'parseError') out.push(c.span!)
  if (Array.isArray(c?.children)) for (const k of c.children) errorsOf(k, out)
  return out
}

describe('tolerant parseDoc — recovered error is a CST child', () => {
  it('embeds a parseError node over the skipped element span', () => {
    const { registry, root } = listGrammar()
    // '$$' where a Value is expected, between the two commas of a 3-slot list.
    const doc = parseDoc<CSTNode>(registry, root, '[1,$$,2]', { tolerant: true })
    expect(doc.tree).not.toBeNull()
    // absolutize by reading spanAt path is overkill; the doc tree is relative but a
    // single-level error under List projects trivially. Just assert one error node
    // exists spanning the '$$' (offsets 3..5 in '[1,$$,2]').
    const errs = errorsOf(absolutize(doc.tree))
    expect(errs.length).toBe(1)
    expect(errs[0]).toEqual({ start: 3, end: 5 })
  })
})

// minimal absolutizer for the assert above (doc.tree is parent-relative)
function absolutize(n: unknown, base = 0): unknown {
  const c = n as { _tag?: string; span: { start: number; end: number }; children?: readonly unknown[] }
  if (!c || typeof c !== 'object') return c
  const start = base + c.span.start
  return {
    ...c,
    span: { start, end: base + c.span.end },
    ...(Array.isArray(c.children) ? { children: c.children.map(k => absolutize(k, start)) } : {}),
  }
}

// ── tolerant oracle fuzz ──────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const int = (r: () => number, n: number) => Math.floor(r() * n)

describe('tolerant parseDoc — edit() === full tolerant reparse (oracle, broken inputs)', () => {
  const SEEDS = 300
  for (const make of [listGrammar, seqGrammar]) {
    it(`matches full tolerant reparse across ${SEEDS} seeds [${make.name}]`, () => {
      const { registry, root } = make()
      const r = mulberry32(0xBADF00D ^ make.name.length * 2654435761)
      const opts = { tolerant: true, structuralReuse: true } as const
      let mismatches = 0
      // start from a small valid doc and apply a chain of random (often-breaking) edits
      let src = make === listGrammar ? '[1,2,3]' : 'x,2,yy,3'
      for (let s = 0; s < SEEDS; s++) {
        const base = parseDoc<CSTNode>(registry, root, src, opts)
        const start = int(r, src.length + 1)
        const deleted = int(r, Math.min(src.length - start, 3) + 1)
        const alphabet = ['0123456789', 'abc', '[],$', ',,', '$$'][int(r, 5)]!
        let inserted = ''
        for (let i = 0, n = int(r, 4); i < n; i++) inserted += alphabet[int(r, alphabet.length)]
        const newSrc = src.slice(0, start) + inserted + src.slice(start + deleted)

        const inc = base.edit(start, start + deleted, inserted)
        const fresh = parseDoc<CSTNode>(registry, root, newSrc, opts)
        const ok = structurallyEqual(inc.tree, fresh.tree)
        if (!ok && mismatches++ < 3) {
          // eslint-disable-next-line no-console
          console.error(`MISMATCH [${make.name}] src=${JSON.stringify(src)} edit=(${start},${deleted},${JSON.stringify(inserted)}) new=${JSON.stringify(newSrc)}`)
        }
        expect(ok).toBe(true)
        src = newSrc.length > 0 ? newSrc : (make === listGrammar ? '[]' : 'x')
      }
      expect(mismatches).toBe(0)
    })
  }
})
