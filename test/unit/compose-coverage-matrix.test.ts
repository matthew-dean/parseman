/**
 * compose() COVERAGE MATRIX — the permanent, auditable home for compose fusion
 * coverage. Every compose() capability or bugfix ADDS ITS ROW HERE (owner rule:
 * every compose fix ships a red-to-green parseman test). The point of this suite is
 * that jess (or any consumer) must NOT be able to surface a compose() bug that this
 * suite would not have caught first.
 *
 * PURE SYNTHETIC PARSEMAN GRAMMARS ONLY. No `@jesscss/*` import, no reproduction of
 * a real grammar. Each axis is modelled with tiny self-contained rules (Leaf / Doc /
 * Name / Token), exactly as the existing compose tests do. "The shapes the four real
 * grammars exercise" means the TOPOLOGY (recognition-alias override, cross-package +
 * reducer + trackLines + ast/cst, N-element arity), reproduced synthetically — never
 * a dependency on css/less/scss/jess.
 *
 * ── COVERAGE TABLE ──────────────────────────────────────────────────────────────
 * Axis                     | value              | cell(s)                  | status
 * -------------------------|--------------------|--------------------------|--------
 * piece topology           | single-package     | topo.single              | tested
 *                          | cross-package      | topo.xpkg + most cells   | tested
 * delta kind               | recognition-only   | delta.recognitionOnly    | tested
 *                          | reducer-bearing    | delta.reducer + most     | tested
 * overridden base shape    | node-rule          | override.nodeRule.{off,on}| tested
 *                          | recognition-ALIAS  | override.alias.{off,on}  | tested
 * hostMode                 | ast                | (default in all cells)   | tested
 *                          | cst                | host.cst.{off,on}        | tested
 * trackLines               | off (control)      | *.off cells              | tested
 *                          | on                 | *.on cells               | tested
 * builder free-bindings    | local-hoisted      | build.localHoisted       | tested
 *                          | core/ast-imported  | build.imported           | tested
 *                          | name-COLLISION     | build.collisionRefused   | tested (refusal STAYS)
 * arity                    | [base, delta]      | (default in all cells)   | tested
 *                          | [base,recA,recB,d] | arity.fourElement        | tested
 *
 * INTENTIONALLY NOT A CELL:
 *  - hostMode declared PER-RULE inside a compose delta (`rules({ hostMode: 'cst' })`)
 *    does NOT propagate to the merged table — hostMode is a GRAMMAR-level property and
 *    the supported channel is `compose(items, { hostMode })` (index.ts:1500). Modelled
 *    via the compose second-arg form in host.cst.*; the per-rule form is not asserted
 *    because it is not the intended contract.
 *  - composeLeaf() runtime refusal — owned by compose-direct-builder-ir.test.ts.
 *
 * RED-ON-0.50.4 ANCHORS (Gap A blast radius — IR serialization dropped a
 * trackLines-wrapped rule's self-referential body, so it re-lowered to
 * `Name: parser({ trackLines: true }, g.Name)`, a bodyless self-cycle the encoder
 * rejects with "alias cycle — lazy (rule 'Name') encodes to its own recursion
 * trampoline"). Both `override.alias.on` AND `override.nodeRule.on` fail on 0.50.4;
 * the base being an alias is one trigger, not the cause — ANY self-referencing rule
 * under trackLines in a compose delta was affected. Green after the ir-serialize fix
 * (scopeSelfBody). The dedicated red→green is compose-alias-override-tracklines.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transformMacro } from '../../src/plugin/index.ts'

const PM = new Set(['parseman'])
const ws = String.raw`const ws = regex(/[ \t\n]*/)`

type Extra = Record<string, string> // extra plain (non-macro) files: name -> contents

/**
 * Transform each module in dependency order, writing every `.js` output to a shared
 * tmp dir so a later module's `import` resolves the emitted artifact. Returns the LAST
 * module's warnings and whether it fused (no runtime `compose(`/`composeLeaf(` left).
 * `h` is the emitted host-mode marker, when present.
 */
function build(modules: Array<[name: string, source: string]>, extra: Extra = {}): {
  warnings: readonly string[]
  fused: boolean
  h: string | undefined
  code: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-matrix-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    for (const [name, contents] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), contents)
    let last: { code: string; warnings: readonly string[] } | undefined
    for (const [name, source] of modules) {
      const tsName = name.replace(/\.js$/, '.ts')
      const out = transformMacro(source, path.join(dir, tsName), PM)
      if (!out) { last = { code: '', warnings: ['<no macro transform>'] }; continue }
      fs.writeFileSync(path.join(dir, name), out.code)
      last = out
    }
    const code = last?.code ?? ''
    return {
      warnings: last?.warnings ?? ['<none>'],
      fused: code.length > 0 && !/\bcompose\s*\(/.test(code) && !/\bcomposeLeaf\s*\(/.test(code),
      h: (code.match(/h:"(\w+)"/) ?? [])[1],
      code,
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Assert a downstream module macro-fused with no runtime fallback. */
function expectFused(r: ReturnType<typeof build>): void {
  expect(r.warnings).toEqual([])
  expect(r.fused).toBe(true)
}

// A cross-package base whose delta overrides a base RECOGNITION-ALIAS (one `cp` object
// bound to two names) with a self-referencing node. `on` toggles trackLines.
const aliasBase = `import { rules, regex, compose } from 'parseman' with { type: 'macro' }
${ws}
const cp = regex(/--[a-z]+/)
export const base = compose([rules({ trivia: ws }, g => ({ Name: cp, Token: cp }))])`
const aliasDelta = (on: boolean) => `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
export const parser = compose([base, rules({ trivia: ws${on ? ', trackLines: true' : ''} }, g => ({
  Name: node('Name', choice(g.Token, g.Name), c => ({ type: 'Name', kids: [...c] })),
}))])`

// A cross-package base whose delta overrides a base NODE-rule with a self-referencing node.
const nodeBase = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
${ws}
export const base = compose([rules({ trivia: ws }, g => ({
  Name: node('Name', regex(/--[a-z]+/), c => ({ type: 'Name', kids: [...c] })),
}))])`
const nodeDelta = (on: boolean) => `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
export const parser = compose([base, rules({ trivia: ws${on ? ', trackLines: true' : ''} }, g => ({
  Name: node('Name', choice(regex(/@[a-z]+/), g.Name), c => ({ type: 'Name', kids: [...c] })),
}))])`

describe('compose coverage matrix', () => {
  describe('piece topology', () => {
    it('single-package: base + delta composed in ONE module (alias override, trackLines)', () => {
      const single = `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
${ws}
const cp = regex(/--[a-z]+/)
const base = compose([rules({ trivia: ws }, g => ({ Name: cp, Token: cp }))])
export const parser = compose([base, rules({ trivia: ws, trackLines: true }, g => ({
  Name: node('Name', choice(g.Token, g.Name), c => ({ type: 'Name', kids: [...c] })),
}))])`
      expectFused(build([['single.ts', single]]))
    })

    it('cross-package: downstream composes over an imported already-composed base', () => {
      expectFused(build([['base.js', aliasBase], ['down.js', aliasDelta(false)]]))
    })
  })

  describe('overridden base shape × trackLines', () => {
    it('recognition-ALIAS override, trackLines OFF (control)', () => {
      expectFused(build([['base.js', aliasBase], ['down.js', aliasDelta(false)]]))
    })
    it('recognition-ALIAS override, trackLines ON (RED on 0.50.4)', () => {
      expectFused(build([['base.js', aliasBase], ['down.js', aliasDelta(true)]]))
    })
    it('node-rule override, trackLines OFF (control)', () => {
      expectFused(build([['base.js', nodeBase], ['down.js', nodeDelta(false)]]))
    })
    it('node-rule override, trackLines ON (RED on 0.50.4 — same class as the alias case)', () => {
      expectFused(build([['base.js', nodeBase], ['down.js', nodeDelta(true)]]))
    })
  })

  describe('delta kind', () => {
    it('recognition-only delta (transform, no node) over an alias base, trackLines ON', () => {
      const down = `import { rules, regex, transform, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
export const parser = compose([base, rules({ trivia: ws, trackLines: true }, g => ({
  Name: transform(choice(g.Token, g.Name), c => c),
}))])`
      expectFused(build([['base.js', aliasBase], ['down.js', down]]))
    })

    it('reducer-bearing delta (node with build) over a node base, trackLines ON', () => {
      expectFused(build([['base.js', nodeBase], ['down.js', nodeDelta(true)]]))
    })
  })

  describe('hostMode (via compose second-arg, the grammar-level channel)', () => {
    const cstBase = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
${ws}
export const base = compose([rules({ trivia: ws }, g => ({ Leaf: node('Leaf', regex(/[a-z]+/)) }))], { hostMode: 'cst' })`
    const cstDown = (on: boolean) => `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
export const parser = compose([base, rules({ trivia: ws${on ? ', trackLines: true' : ''} }, g => ({
  Doc: node('Doc', choice(g.Leaf, g.Doc)),
}))], { hostMode: 'cst' })`

    it('cst host, trackLines OFF — emits a cst table', () => {
      const r = build([['base.js', cstBase], ['down.js', cstDown(false)]])
      expectFused(r)
      expect(r.h).toBe('cst')
    })
    it('cst host, trackLines ON — emits a cst table (real less/scss/jess shape)', () => {
      const r = build([['base.js', cstBase], ['down.js', cstDown(true)]])
      expectFused(r)
      expect(r.h).toBe('cst')
    })
    it('ast host (default), reducer-bearing, trackLines ON — emits an ast table', () => {
      const r = build([['base.js', nodeBase], ['down.js', nodeDelta(true)]])
      expectFused(r)
      expect(r.h).toBe('ast')
    })
  })

  describe('builder free-bindings', () => {
    it('local-hoisted reducer (defined in the delta module) fuses under trackLines', () => {
      const base = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
${ws}
export const base = compose([rules({ trivia: ws }, g => ({ Leaf: node('Leaf', regex(/[a-z]+/), c => ({ t: 'L', c: [...c] })) }))])`
      const down = `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
const mkDoc = c => ({ t: 'Doc', c: [...c] })
export const parser = compose([base, rules({ trivia: ws, trackLines: true }, g => ({
  Doc: node('Doc', choice(g.Leaf, g.Doc), mkDoc),
}))])`
      expectFused(build([['base.js', base], ['down.js', down]]))
    })

    it('imported ast-factory reducer fuses under trackLines (import provenance re-emitted)', () => {
      const base = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
import { mk } from './astf.js'
${ws}
export const base = compose([rules({ trivia: ws }, g => ({ Leaf: node('Leaf', regex(/[a-z]+/), c => mk(c)) }))])`
      const down = `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
export const parser = compose([base, rules({ trivia: ws, trackLines: true }, g => ({
  Doc: node('Doc', choice(g.Leaf, g.Doc), c => ({ t: 'Doc', c: [...c] })),
}))])`
      expectFused(build([['base.js', base], ['down.js', down]], { 'astf.js': "export const mk = (c) => ({ t: 'M', c: [...c] })\n" }))
    })

    it('name-COLLISION on a re-emitted builder import is REFUSED — refusal STAYS (Gap C is jess-side)', () => {
      // Base's inherited reducer needs `mk` from ./a.js; the downstream module binds its
      // OWN `mk` from ./b.js. The inlined builder source names `mk` verbatim, so the
      // import cannot be aliased — parseman refuses rather than mis-bind. This is the
      // correct behavior; Gap C is fixed jess-side by renaming, NOT by making parseman
      // permissive. (Authoritative twin: compose-direct-builder-ir.test.ts "REFUSES …".)
      const base = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
import { mk } from './a.js'
${ws}
export const base = compose([rules({ trivia: ws }, g => ({ Leaf: node('Leaf', regex(/[a-z]+/), c => mk(c)) }))])`
      const down = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
import { mk } from './b.js'
${ws}
const other = node('Other', regex(/#[a-z]+/), c => mk(c))
export const parser = compose([base, rules({ trivia: ws }, g => ({ Other: other }))])`
      expect(() => build(
        [['base.js', base], ['down.js', down]],
        { 'a.js': "export const mk = (c) => ({ t: 'A', c: [...c] })\n", 'b.js': "export const mk = (c) => ({ t: 'B', c: [...c] })\n" },
      )).toThrow(/parseman will not emit this module.*already binds `mk`/s)
    })
  })

  describe('arity', () => {
    it('two-element [base, rules(delta)] fuses (baseline arity)', () => {
      expectFused(build([['base.js', nodeBase], ['down.js', nodeDelta(true)]]))
    })

    it('four-element [base, recogA, recogB, rules(reducerDelta)] fuses (real superset arity)', () => {
      const base = `import { rules, regex, node, compose } from 'parseman' with { type: 'macro' }
${ws}
export const base = compose([rules({ trivia: ws }, g => ({ Leaf: node('Leaf', regex(/[a-z]+/), c => ({ t: 'L', c: [...c] })) }))])`
      const down = `import { rules, regex, node, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
${ws}
export const parser = compose([
  base,
  rules({ trivia: ws }, g => ({ RecA: regex(/#[a-z]+/) })),
  rules({ trivia: ws }, g => ({ RecB: regex(/@[a-z]+/) })),
  rules({ trivia: ws, trackLines: true }, g => ({
    Doc: node('Doc', choice(g.Leaf, g.RecA, g.RecB, g.Doc), c => ({ t: 'Doc', c: [...c] })),
  })),
])`
      expectFused(build([['base.js', base], ['down.js', down]]))
    })
  })
})
