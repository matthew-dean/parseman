/**
 * A combinator lying ON a self-reference cycle must be emitted INSIDE the cycle's
 * `ref()/define()` closure, never hoisted to a shared `const`.
 *
 * The cycle's only lazy edge is the local `ref()` var that closure binds. Hoisting a
 * cycle-interior node puts it at decl scope, where that var does not exist, so the
 * back-edge re-resolves through the cycle target's own const — two decls that read
 * each other eagerly. `emitDecl` pushes the inner one first, so composing the IR
 * throws `ReferenceError: Cannot access '_sN' before initialization`.
 *
 * `balanced()`'s interior is referenced exactly once so it never earns a const; the
 * two shapes below are the ones that do.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, literal, sequence, choice, many, transform, expect as expectC } from '../../src/index.ts'
import { ref } from '../../src/combinators/ref.ts'
import { compileLinkableTable as compileLinkable } from '../../src/compiler/compile-linkable-table.ts'
import { serializeRuleMap, evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'

import type { Combinator } from '../../src/types.ts'

type Comb = Combinator<unknown>
type RunMap = Record<string, (i: string, p: number, c: object) => { ok: boolean; value?: unknown; span: { end: number } }>

const JOIN_SRC =
  '([o, parts, c]) => o + parts.map(p => typeof p === "string" ? p : Array.isArray(p) ? p.join("") : "").join("") + (typeof c === "string" ? c : "")'

const join = ([o, parts, c]: [string, unknown, unknown]): string =>
  o + (parts as unknown[]).map(p => (typeof p === 'string' ? p : Array.isArray(p) ? p.join('') : '')).join('')
    + (typeof c === 'string' ? c : '')

/** `transform(sequence(open, inner, expect(close)), join)` with the source captured,
 * i.e. exactly the group shape `buildBalancedInterior` emits. */
function group(open: string, close: string, inner: Comb): Comb {
  const g = transform(sequence(literal(open), inner as never, expectC(literal(close))), join as never) as Comb
  if (g._def.tag === 'transform') { g._def.fnSrc = JOIN_SRC; g._def.recognitionOnly = true }
  return g
}

function run(rm: ReadonlyArray<readonly [string, unknown]>): RunMap {
  const pieces = compileLinkable(rm as never, '_t_')
  if (!pieces) throw new Error('not linkable')
  return pieces.rules as unknown as RunMap
}

/** Serialize, compose, re-lower, and compare against the original on every input. */
function roundTrip(rm: ReadonlyArray<readonly [string, unknown]>, rule: string, inputs: string[]): string {
  const src = serializeRuleMap(rm as never)
  expect(src, 'serializable').not.toBeNull()
  // This is the step that throws on the unfixed serializer.
  const entries = evalRuleMapIR(src!)
  const rebuilt = run(entries)
  const original = run(rm)
  for (const input of inputs) {
    const a = original[rule]!(input, 0, {})
    const b = rebuilt[rule]!(input, 0, {})
    expect(b.ok, `ok mismatch on ${JSON.stringify(input)}`).toBe(a.ok)
    if (a.ok) {
      expect(b.span.end, `end mismatch on ${JSON.stringify(input)}`).toBe(a.span.end)
      expect(b.value, `value mismatch on ${JSON.stringify(input)}`).toEqual(a.value)
    }
  }
  return src!
}

describe('IR serialize: a self-reference cycle must not be hoisted apart', () => {
  it('a SHARED interior referenced once per arm of a recursive multi-pair group', () => {
    // One `many` reused by both arms -> refcount 2 -> it used to earn a const, and
    // that const sat outside the ref()/define() closure holding the back-edge.
    const self = ref<string>()
    const content = regex(/[^()[\]]+/)
    const inner = many(choice(self as never, content))
    const both = choice(group('(', ')', inner), group('[', ']', inner))
    self.define(both as never)

    const rm = Object.entries(rules(() => ({ Doc: both })))
    const src = roundTrip(rm, 'Doc', [
      '()', '(a)', '[a]', '(a[b]c)', '[a(b)c]', '((()))', '[[[]]]', '([a])', '(a', '[a)',
    ])

    // The interior is inlined into each arm and names the closure's ref var; no decl
    // outside the closure may reference the cycle.
    expect(src).toContain('_rr0')
    expect(src).not.toMatch(/const _s\d+ = many\(/)
  })

  it('a NESTED recursive combinator that is itself on the outer cycle', () => {
    // Parens may contain brackets, brackets may contain parens: the back-edge to the
    // outer group runs THROUGH the inner one, so the inner group is cycle-interior
    // AND self-referential. It loses its const and must still get its own
    // ref()/define() wrapper, with the outer frame still visible inside it.
    const outer = ref<string>()
    const innerRef = ref<string>()
    const content = regex(/[^()[\]]+/)
    const brack = group('[', ']', many(choice(innerRef as never, outer as never, content)))
    innerRef.define(brack as never)
    const paren = group('(', ')', many(choice(outer as never, brack, content)))
    outer.define(paren as never)

    const rm = Object.entries(rules(() => ({ Doc: paren })))
    const src = roundTrip(rm, 'Doc', [
      '()', '(a)', '([b])', '([(c)])', '((a)[b])', '([a][b])', '(', '([a)',
    ])

    // Two distinct ref vars, and the inner closure nests inside the outer one so the
    // outer's ref var is still in scope where the inner group names it.
    expect(src).toContain('_rr0')
    expect(src).toContain('_rr1')
    expect(src.indexOf('_rr1')).toBeGreaterThan(src.indexOf('const _rr0'))
    // A node OFF the cycle (the shared content regex) may still be hoisted; a hoisted
    // decl must never name a ref var, because decl scope cannot see one.
    for (const decl of src.split('\n').filter(l => /^\s*const _s\d+ = /.test(l))) {
      expect(decl, 'hoisted decl names a ref var').not.toContain('_rr')
    }
  })
})
