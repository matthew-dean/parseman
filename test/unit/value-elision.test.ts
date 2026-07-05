/**
 * Dead-value elision — guards for the `markUnusedValues` optimization.
 *
 * A container combinator (`many` / `oneOrMore` / `sequence` / `optional`) builds
 * an aggregate value. Under a `node()`, the node builds strictly from *captured
 * children* and never observes that aggregate — so building it is pure waste.
 * `markUnusedValues` marks such containers `valueUnused`; the interpreter and the
 * emitter then skip the array/tuple allocation. Elements still parse and
 * self-capture, so trees are byte-identical.
 *
 * Two kinds of guard here:
 *   1. CORRECTNESS — a container under a node yields the *same tree* whether or
 *      not its value is elided, and a container whose value IS read (transform,
 *      sepBy item, rule root) keeps its aggregate. A future soundness hole fails
 *      these loudly.
 *   2. PERF-REGRESSION — the compiled hot path for `node(many(...))` contains no
 *      array allocation / `.push`. If elision silently stops applying, the code
 *      shape changes and this fails — a deterministic proxy for the CPU win.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, many, oneOrMore, optional, sepBy, transform,
  parse, parser, node, rules, ref,
} from '../../src/index.ts'
import type { Combinator, ParserDef, CSTNode, Span } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { markUnusedValues } from '../../src/compiler/value-usage.ts'

const digits = regex(/[0-9]+/)

function mkCst(type: string, children: CSTNode['children'], span: Span, state: unknown): CSTNode {
  return { _tag: 'node', type, span, state, children: [...children] }
}

/** Reach a combinator's ParserDef.valueUnused flag (analysis output). */
function unused(c: Combinator<unknown>): boolean | undefined {
  return (c._def as ParserDef & { valueUnused?: boolean }).valueUnused
}

// ---------------------------------------------------------------------------
// Analysis contract — which containers get marked
// ---------------------------------------------------------------------------
describe('markUnusedValues — analysis contract', () => {
  it('marks a many whose value only feeds a node() capture', () => {
    const inner = many(digits)
    const N = node('N', parser({}, inner), (ch, _r, span, _tl, st) =>
      mkCst('N', ch as CSTNode['children'], span, st))
    markUnusedValues(N as Combinator<unknown>)
    expect(unused(inner)).toBe(true)
  })

  it('does NOT mark a many read by a transform', () => {
    const inner = many(digits)
    const T = transform(inner, xs => xs.length)
    markUnusedValues(T as Combinator<unknown>)
    expect(unused(inner)).toBe(false)
  })

  it('does NOT mark a many at a rule root (value assumed observed)', () => {
    const inner = many(digits)
    markUnusedValues(inner as Combinator<unknown>)
    expect(unused(inner)).toBe(false)
  })

  it('optional carries no valueUnused flag, but its inner container still elides', () => {
    // `optional` returns `inner | null` — no aggregate to elide, so it's never
    // marked; the `many` INSIDE it under a node() is still elided.
    const innerMany = many(digits)
    const opt = optional(innerMany)
    const N = node('N', parser({}, opt), (ch, _r, span, _tl, st) =>
      mkCst('N', ch as CSTNode['children'], span, st))
    markUnusedValues(N as Combinator<unknown>)
    expect(unused(opt)).toBeUndefined()   // optional never carries the flag
    expect(unused(innerMany)).toBe(true)  // its inner many is still elided
  })

  it('does NOT mark a sepBy item parser (sepBy always builds its array)', () => {
    const item = sequence(digits)
    const S = sepBy(item, literal(','))
    const N = node('N', parser({}, S), (ch, _r, span, _tl, st) =>
      mkCst('N', ch as CSTNode['children'], span, st))
    markUnusedValues(N as Combinator<unknown>)
    expect(unused(item)).toBe(false)
  })

  it('sharing-safe: a container reached from BOTH a node and a transform keeps its value', () => {
    // The SAME `many` object appears in two spots of one tree: under a node
    // (value discarded) and inside a transform (value read). The consuming visit
    // must win and be sticky, regardless of walk order.
    const shared = many(digits)
    const root = sequence(
      node('V', parser({}, shared), (ch, _r, span, _tl, st) =>
        mkCst('V', ch as CSTNode['children'], span, st)),
      transform(shared, xs => xs.length),
    )
    markUnusedValues(root as Combinator<unknown>)
    expect(unused(shared)).toBe(false)
  })

  it('sequence and oneOrMore under a node are both marked', () => {
    const seq = sequence(digits, literal('+'), digits)
    const rep = oneOrMore(digits)
    const N = node('N', parser({}, sequence(seq, rep)), (ch, _r, span, _tl, st) =>
      mkCst('N', ch as CSTNode['children'], span, st))
    markUnusedValues(N as Combinator<unknown>)
    expect(unused(seq)).toBe(true)
    expect(unused(rep)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Ref-rooted rules — the shape real grammars (rules()/compose) actually use.
// A forward-referenced rule's root is a ref()/lazy wrapping the node body; the
// analysis must resolve that root lazy or it walks nothing and elides nothing.
// (Regression guard: the original pass silently no-op'd on every ref-rooted rule,
// so elision never fired on the real Less/CSS grammars.)
// ---------------------------------------------------------------------------
describe('markUnusedValues — ref-rooted rules (rules()/compose shape)', () => {
  it('elides a many inside a node whose rule root is a ref (forward reference)', () => {
    // `Wrapper` references `Doc` → Doc's cache slot becomes a ref()/lazy, so
    // markUnusedValues(Doc) hits the root lazy and MUST resolve it to reach the
    // `many` in Doc's body. Without resolveRoot the many is never walked (RED).
    let itemMany: Combinator<unknown> | undefined
    const g = rules<{ Wrapper: Combinator<unknown>; Doc: Combinator<unknown>; Item: Combinator<unknown> }>(r => {
      const inner = many(r.Item)
      itemMany = inner
      return {
        Wrapper: node('Wrapper', parser({}, r.Doc), (ch, _r, span, _tl, st) =>
          mkCst('Wrapper', ch as CSTNode['children'], span, st)),
        Doc: node('Doc', parser({}, inner), (ch, _r, span, _tl, st) =>
          mkCst('Doc', ch as CSTNode['children'], span, st)),
        Item: node('Item', digits, (ch, _r, span, _tl, st) =>
          mkCst('Item', ch as CSTNode['children'], span, st)),
      }
    })
    void g
    // rules() runs markUnusedValues per rule; the many under Doc's (ref-rooted) node must be marked.
    expect(unused(itemMany!)).toBe(true)
  })

  it('resolveRoot: markUnusedValues on a bare ref walks the defined body', () => {
    const inner = many(digits)
    const body = node('N', parser({}, inner), (ch, _r, span, _tl, st) =>
      mkCst('N', ch as CSTNode['children'], span, st))
    const r = ref<unknown>()
    r.define(body)
    markUnusedValues(r as Combinator<unknown>)   // root IS a lazy
    expect(unused(inner)).toBe(true)
  })

  it('an undefined ref root is a no-op, not a throw', () => {
    const r = ref<unknown>()
    expect(() => markUnusedValues(r as Combinator<unknown>)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Correctness — elision never changes the tree
// ---------------------------------------------------------------------------
describe('value elision — correctness (tree is identical)', () => {
  // Build a fresh node grammar each time so markUnusedValues sees a distinct tree.
  const makeGrammar = () => {
    const Item = node('Item', digits, (ch, _r, span, _tl, st) =>
      mkCst('Item', ch as CSTNode['children'], span, st))
    return node('List', parser({}, many(Item)), (ch, _r, span, _tl, st) =>
      mkCst('List', ch as CSTNode['children'], span, st))
  }

  it('interpreter and compiled backends agree on the captured tree', () => {
    const interp = makeGrammar()
    const r = parse(interp, '1234')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // one child per digit char? no — Item matches a full digit run; input is one Item
    expect(r.value.type).toBe('List')
    const items = r.value.children.filter(c => c._tag === 'node') as CSTNode[]
    expect(items.length).toBe(1)
    expect(items[0]!.type).toBe('Item')

    // Compiled path must produce the same shape.
    const compiled = compile(makeGrammar())
    const cr = compiled.parse('1234') as { ok: boolean; value: CSTNode }
    expect(cr.ok).toBe(true)
    expect(cr.value.type).toBe('List')
    expect((cr.value.children.filter(c => c._tag === 'node') as CSTNode[]).length).toBe(1)
  })

  it('a many whose value IS observed still returns its array', () => {
    const counted = transform(many(digits), xs => xs.length)
    // three digit-runs separated by non-digits so many yields 3 items
    const r = parse(parser({}, counted), '1a')
    // markUnusedValues ran via parse(); value must be intact (not elided to undefined)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(typeof r.value).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Perf-regression guard — the optimization is actually applied
// ---------------------------------------------------------------------------
describe('value elision — perf-regression guard (compiled shape)', () => {
  it('node(many(...)) emits NO array allocation / push for the elided aggregate', () => {
    const Item = node('Item', digits, (ch, _r, span, _tl, st) =>
      mkCst('Item', ch as CSTNode['children'], span, st))
    const List = node('List', parser({}, many(Item)), (ch, _r, span, _tl, st) =>
      mkCst('List', ch as CSTNode['children'], span, st))
    const src = compile(List).source
    // The captured-children buffers (`_sc*`/`_sr*`) still exist and push — those
    // build the CST. What must vanish is the many's OWN value array `_arrN`: no
    // `_arrN = []` allocation and no `_arrN.push`.
    expect(src).not.toMatch(/_arr\d+\s*=\s*\[\]/)
    expect(src).not.toMatch(/_arr\d+\.push\(/)
  })

  it('a many whose value IS read still emits its value-array push (guard is not a no-op)', () => {
    const counted = transform(many(digits), xs => xs.length)
    const src = compile(counted).source
    expect(src).toMatch(/_arr\d+\s*=\s*\[\]/)
    expect(src).toMatch(/_arr\d+\.push\(/)
  })
})
