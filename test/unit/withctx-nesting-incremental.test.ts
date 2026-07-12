/**
 * withCtx + inner-guard woven into a realistic CSS-nesting-shaped grammar, and
 * verified end to end — the "does the 0.26.0 context story actually work in
 * practice" test.
 *
 * A nested block installs `{ inner: true }` via `withCtx`; `&` is a gated `choice`
 * arm valid ONLY when `inner` is set. So:
 *   - top-level `&` is rejected (no inner context)
 *   - nested `&` is accepted, at any depth
 *
 * The load-bearing question is (2): does an incremental `.edit()` PRESERVE the
 * inner context? It does, and this pins both the behavior and the mechanism:
 *   - the oracle — `.edit()` ≡ a fresh full tolerant `parseDoc` — holds across
 *     edits that FLIP whether a selector is in inner context (ident⇄`&`,
 *     top-level⇄nested). If context were dropped on reparse, the incremental tree
 *     would diverge from the full parse.
 *   - the mechanism — `node()` captures `ctx.state`, localized reparse restores it
 *     (`doc.ts` ~L731 `mkCtx(node.state, …)`), and the splice-reuse path refuses to
 *     reuse a state-carrying node (`doc.ts` ~L429 `state != null → return null`), so
 *     inner content is re-derived under its captured context rather than blindly
 *     spliced.
 *
 * (3) the same grammar drives `languageService.openDocument`, and (4) it stays
 * macro-compiled (no interpreter fallback) with the gate predicate inlined.
 */
import { describe, it, expect } from 'vitest'
import {
  rules, node, sequence, many, choice, literal, regex, withCtx,
  parseDoc, cstBuildHost,
} from '../../src/index.ts'
import type { Combinator, GatedArm } from '../../src/index.ts'
import type { Registry } from '../../src/functional/doc.ts'
import { structurallyEqual } from '../../src/functional/doc.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { languageService } from '../../src/language-service/index.ts'
import type { CSTNode } from '../../src/cst/types.ts'

// A nesting grammar: `sel{ block }`, block contents are `inner`, `&` gated on inner.
// Structural node()s (no build callback) so it serves both parseDoc(+cstBuildHost)
// and languageService.openDocument uniformly.
function nestGrammar() {
  const g = rules((self) => ({
    Sheet:    node(many(self.Ruleset)),
    Ruleset:  node(sequence(self.Selector, self.Block)),
    Block:    node(sequence(literal('{'), withCtx({ inner: true }, many(self.Ruleset)), literal('}'))),
    Selector: node(choice(
      { gate: (s) => !!(s as { inner?: boolean } | undefined)?.inner, combinator: literal('&') } satisfies GatedArm<string>,
      regex(/[a-z]+/),
    )),
  }))
  return g as unknown as Registry<CSTNode>
}

const OPTS = { tolerant: true as const, structuralReuse: true as const, build: cstBuildHost() }

function errorsOf(n: unknown, out: Array<{ start: number; end: number }> = []): typeof out {
  const c = n as { _tag?: string; span?: { start: number; end: number }; children?: readonly unknown[] }
  if (c?._tag === 'parseError') out.push(c.span!)
  if (Array.isArray(c?.children)) for (const k of c.children) errorsOf(k, out)
  return out
}

describe('withCtx nesting — interpreter accept/reject', () => {
  const g = nestGrammar()
  const parse = (src: string) => {
    const d = parseDoc(g, 'Sheet', src, { ...OPTS, build: cstBuildHost() })
    return { errs: errorsOf(d.tree).length, unconsumedFrom: d.unconsumedFrom }
  }

  it('accepts nested `&` at any depth', () => {
    expect(parse('a{}')).toEqual({ errs: 0, unconsumedFrom: null })
    expect(parse('a{b{}}')).toEqual({ errs: 0, unconsumedFrom: null })
    expect(parse('a{&{}}')).toEqual({ errs: 0, unconsumedFrom: null })
    expect(parse('a{&{&{}}}')).toEqual({ errs: 0, unconsumedFrom: null })
  })

  it('rejects top-level `&` (no inner context)', () => {
    // Nothing consumed — the gated `&` arm is blocked and `&` is not an ident.
    expect(parse('&{}').unconsumedFrom).toBe(0)
    // Parses the first rule, then stops at the top-level `&`.
    expect(parse('a{}&{}').unconsumedFrom).toBe(3)
  })
})

describe('withCtx nesting — incremental edits PRESERVE inner context (oracle)', () => {
  const g = nestGrammar()
  // Apply edits in sequence; after each, assert the incremental tree equals a fresh
  // full tolerant parse of the resulting text (context-inclusive), and check the
  // context-dependent accept/reject directly.
  function drive(src0: string, edits: Array<[number, number, string]>) {
    let doc = parseDoc(g, 'Sheet', src0, { ...OPTS, build: cstBuildHost() })
    let text = src0
    for (const [from, to, repl] of edits) {
      doc = doc.edit(from, to, repl)
      text = text.slice(0, from) + repl + text.slice(to)
      const fresh = parseDoc(g, 'Sheet', text, { ...OPTS, build: cstBuildHost() })
      expect(structurallyEqual(doc.tree, fresh.tree),
        `oracle mismatch after edit → ${JSON.stringify(text)}`).toBe(true)
      expect(doc.unconsumedFrom, `unconsumedFrom after → ${JSON.stringify(text)}`)
        .toBe(fresh.unconsumedFrom)
    }
    return { doc, text }
  }

  it('ident → `&` inside a nested block stays valid (context applied on reparse)', () => {
    // 'a{b{}}' : positions a0 {1 b2 {3 }4 }5 — replace inner ident `b` with `&`.
    drive('a{b{}}', [[2, 3, '&']])
    // The reparsed inner Selector saw inner:true → `&` accepted, no error, no junk.
    const d = parseDoc(g, 'Sheet', 'a{&{}}', { ...OPTS, build: cstBuildHost() })
    expect(errorsOf(d.tree).length).toBe(0)
  })

  it('`&` → ident inside a nested block (reverse flip)', () => {
    drive('a{&{}}', [[2, 3, 'c']]) // → 'a{c{}}'
  })

  it('top-level ident → `&` becomes rejected after the edit', () => {
    // 'a{}' : a0 {1 }2 — replace top-level `a` with `&`; now `&{}` is top-level.
    const { doc } = drive('a{}', [[0, 1, '&']])
    expect(doc.unconsumedFrom).toBe(0) // top-level `&` rejected post-edit
  })

  it('inserting a sibling nested ruleset keeps inner context', () => {
    // 'a{&{}}' → insert 'b{}' before the final `}` (offset 5) → 'a{&{}b{}}'
    drive('a{&{}}', [[5, 5, 'b{}']])
  })

  it('deepening the nesting keeps inner context at the new depth', () => {
    // 'a{&{}}' : a0 {1 &2 {3 }4 }5 — insert '&{}' just inside the inner block (offset 4)
    // → 'a{&{&{}}}' (a `&` nested inside the `&` block)
    drive('a{&{}}', [[4, 4, '&{}']])
  })

  it('a run of edits that repeatedly flips context still tracks the full parse', () => {
    drive('a{b{}}', [
      [2, 3, '&'],     // a{&{}}   ident→& (inner)
      [5, 5, 'c{}'],   // a{&{}c{}} add sibling
      [2, 3, 'x'],     // a{x{}c{}} &→ident
      [0, 1, '&'],     // &{x{}c{}} top-level →& : now REJECTED at 0
    ])
  })
})

describe('withCtx nesting — languageService.openDocument', () => {
  const g = nestGrammar()
  const svc = languageService({ rules: g, root: 'Sheet' }, {
    diagnostics: {
      // a lint rule keyed by node type, to exercise the config path
      Selector: (n) => {
        const leaf = (n as unknown as { children?: Array<{ value?: string }> }).children?.[0]
        return leaf?.value === 'x'
          ? [{ severity: 'warning' as const, message: 'avoid x', span: (n as { span: { start: number; end: number } }).span }]
          : []
      },
    },
  })

  it('parses, edits, and preserves inner context through the LS document', () => {
    let d = svc.openDocument('a{&{}}')
    expect(d.tree).not.toBeNull()
    expect(d.diagnostics()).toEqual([]) // valid, no lint hit
    // edit a sibling in; still valid nested context
    d = d.edit(5, 5, 'x{}') // a{&{}x{}}
    // the `x` selector trips the lint rule → one warning, and no structural error
    const diags = d.diagnostics()
    expect(diags.some((dg) => dg.message === 'avoid x')).toBe(true)
    expect(diags.some((dg) => dg.severity === 'error')).toBe(false)
  })

  it('surfaces a missing-closer as a diagnostic and offers completions', () => {
    const d = svc.openDocument('a{&{}') // missing final `}`
    expect(d.diagnostics().length).toBeGreaterThan(0)
    // completions at end-of-input return items (structural expected-set at minimum)
    expect(Array.isArray(d.completionsAt(5))).toBe(true)
  })
})

describe('withCtx nesting — stays macro-compiled', () => {
  it('compiles the grammar with the macro, no interpreter fallback, gate inlined', () => {
    const src = `
import { rules, node, sequence, many, choice, literal, regex, withCtx } from 'parseman' with { type: 'macro' }
const grammar = rules((self) => ({
  Sheet:    node(many(self.Ruleset)),
  Ruleset:  node(sequence(self.Selector, self.Block)),
  Block:    node(sequence(literal('{'), withCtx({ inner: true }, many(self.Ruleset)), literal('}'))),
  Selector: node(choice(
    { gate: (s) => !!(s && s.inner), combinator: literal('&') },
    regex(/[a-z]+/),
  )),
}))
`
    const out = transformMacro(src, 'grammar.ts', new Set(['parseman']))
    expect(out).not.toBeNull()
    // no interpreter fallback for any rule
    expect(out!.warnings.join('\n')).not.toMatch(/statically evaluable|interpreter|fallback/i)
    expect(out!.code).not.toContain('rules(')
    // the gate predicate + the withCtx extra getter are inlined as mapFns
    expect(out!.code).toMatch(/s\.inner/)
    expect(out!.code).toMatch(/inner:\s*true/)
  })
})
