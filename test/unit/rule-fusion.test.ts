/**
 * Build-time fusion (RULE_ABI_PLAN §4): independently-compiled linkable
 * artifacts fuse into one closure of direct-call parse functions, with override
 * (open recursion), à la carte selection, and a name-closure check.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, choice, sequence, literal, optional, sepBy, node, compile, parseDoc, many, parser, trivia } from '../../src/index.ts'
import type { Combinator, Registry, NodeLike } from '../../src/index.ts'
import { compose } from '../../src/index.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { fuseRules, pick, cstBuildHost } from '../../src/compiler/linker.ts'

const link = (g: Record<string, Combinator<unknown>>, ns: string) =>
  compileLinkable([...Object.entries(g)], ns)!

const ok = (r: { ok: boolean; span: { end: number } }) => (r.ok ? r.span.end : -1)

describe('macro: compose() fuses to STATIC source (eval-free)', () => {
  it('compiles compose([...]) at build with no new Function, and it parses', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const src = `import { rules, regex, choice, compose } from 'parseman' with { type: 'macro' }
const cssRules = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))
const lessRules = rules(g => ({ Num: regex(/[0-9]+X/) }))
export const parser = compose([cssRules, lessRules])`
    const out = transformMacro(src, '/pkg/less.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    // Build-time fused: no compose() call and NO new Function anywhere.
    expect(/\bcompose\s*\(/.test(out.code)).toBe(false)
    expect(/new Function/.test(out.code)).toBe(false)
    // The emitted parser works, and the override reroutes (open recursion).
    const parser = new Function(out.code.replace(/^import[^\n]*\n/m, '').replace(/export const/g, 'var') + '\nreturn parser')() as Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>
    expect(parser.Value!('abc', 0, {}).span.end).toBe(3)    // css.Word
    expect(parser.Value!('12X', 0, {}).span.end).toBe(3)    // css.Value → less.Num (override)
    expect(parser.Value!('12', 0, {}).ok).toBe(false)       // less.Num needs 'X'
  })
})

describe('macro: cross-package compose() with NO base source (sidecar)', () => {
  it('a consumer composes an imported COMPILED grammar — build-fused, eval-free', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-xpkg-'))
    // "css package" compiled → ships cssRules + its cssRules__pieces sidecar.
    const cssOut = transformMacro(
      `import { rules, regex, choice } from 'parseman' with { type: 'macro' }
export const cssRules = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))`,
      path.join(dir, 'css.js'), new Set(['parseman']))!
    // Pieces travel ON the exported grammar value (Symbol-keyed), NOT a separate
    // `__pieces` export — `import { cssRules }` carries everything.
    expect(cssOut.code).toMatch(/Symbol\.for\('parseman\.composedPieces'\)/)
    expect(/__pieces\b/.test(cssOut.code)).toBe(false)
    fs.writeFileSync(path.join(dir, 'css.js'), cssOut.code)
    // "less package" imports the COMPILED css (no css source) and composes.
    const lessOut = transformMacro(
      `import { rules, regex, compose } from 'parseman' with { type: 'macro' }
import { cssRules } from './css.js'
export const parser = compose([cssRules, rules(g => ({ Num: regex(/[0-9]+Z/) }))])`,
      path.join(dir, 'less.js'), new Set(['parseman']))!
    expect(lessOut.warnings).toEqual([])
    expect(/\bcompose\s*\(/.test(lessOut.code)).toBe(false)   // build-fused
    expect(/new Function/.test(lessOut.code)).toBe(false)     // eval-free
    // The cross-package `Value = choice(Num, Word)` arms have disjoint first chars
    // (digit vs letter). Their dispatch guard is a placeholder in css.js resolved at
    // FUSE time from css's serialized `firstSets` (carried in the pieces). Verify it
    // survived the artifact boundary. The ACTIVE fused code (before the carried
    // `composedPieces` literal) must have a resolved code-point guard and no leftover
    // placeholder; the carried pieces DO retain the placeholder — they resolve at the
    // next fuse (re-composability). Guards a serializePieces regression that would
    // silently disable cross-file dispatch.
    const activeCode = lessOut.code.split('composedPieces')[0]!
    expect(/@FS:/.test(activeCode)).toBe(false)                       // active guard resolved
    expect(/_chcode\w*\s*(?:>=|===|<=)/.test(activeCode)).toBe(true)  // …to a real code-point check
    expect(/firstSets:/.test(lessOut.code)).toBe(true)               // carried for the next fuse
    const parser = new Function(lessOut.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn parser')() as Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>
    expect(parser.Value!('abc', 0, {}).span.end).toBe(3)      // css.Word
    expect(parser.Value!('12Z', 0, {}).span.end).toBe(3)      // css.Value → less.Num (override across packages)
    expect(parser.Value!('12', 0, {}).ok).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('macro: 3-level compose() chain across packages (re-composable sidecar)', () => {
  it('scss composes less composes css — each imported COMPILED, override chains', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-chain-'))
    const build = (name: string, src: string) => {
      const out = transformMacro(src, path.join(dir, `${name}.js`), new Set(['parseman']))!
      expect(out.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, `${name}.js`), out.code)
      return out.code
    }
    build('css', `import { rules, regex, choice } from 'parseman' with { type: 'macro' }
export const cssGrammar = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))`)
    // less composes the COMPILED css and overrides Num → ships its own sidecar.
    const lessCode = build('less', `import { rules, regex, compose } from 'parseman' with { type: 'macro' }
import { cssGrammar } from './css.js'
export const lessGrammar = compose([cssGrammar, rules(g => ({ Num: regex(/[0-9]+L/) }))])`)
    expect(lessCode).toMatch(/Symbol\.for\('parseman\.composedPieces'\)/)   // re-composable: pieces on the value
    expect(/new Function/.test(lessCode)).toBe(false)
    // scss composes the COMPILED less (a composed grammar) and overrides Num.
    const scssCode = build('scss', `import { rules, regex, compose } from 'parseman' with { type: 'macro' }
import { lessGrammar } from './less.js'
export const scssGrammar = compose([lessGrammar, rules(g => ({ Num: regex(/[0-9]+S/) }))])`)
    expect(/\bcompose\s*\(/.test(scssCode)).toBe(false)
    expect(/new Function/.test(scssCode)).toBe(false)
    const scss = new Function(scssCode.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn scssGrammar')() as Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>
    expect(scss.Value!('12S', 0, {}).span.end).toBe(3)  // scss.Num overrides less overrides css
    expect(scss.Value!('12L', 0, {}).ok).toBe(false)     // less's Num was overridden by scss
    expect(scss.Value!('abc', 0, {}).span.end).toBe(3)   // css.Word inherited through the chain
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('extending a grammar via compose() — no base source, no opt-in', () => {
  it('a consumer extends a base grammar with compose([base, ext]) — override reroutes', () => {
    // A base grammar (a plain rules() result — no `linkable()` wrapper, composable
    // by default) and an extension that overrides Num. compose() takes grammars
    // directly (linkable-ifies them internally).
    const cssRules = rules(g => ({
      Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/),
    }))
    const lessRules = rules(() => ({ Num: regex(/[0-9]+!/) }))
    const R = compose([cssRules, lessRules])
    expect(ok(R.Value!('abc', 0, {}))).toBe(3)   // css.Word
    expect(ok(R.Value!('12!', 0, {}))).toBe(3)   // css.Value reroutes to less.Num (open recursion)
    expect(ok(R.Value!('12', 0, {}))).toBe(-1)   // less.Num needs '!'; Word fails
  })
})

describe('fusion — each grammar keeps its OWN trivia (no _tf collision)', () => {
  // Regression: hoisted trivia-skip functions (`_tf<N>`) were NOT namespaced, so
  // two fused pieces each defined `_tf0` and the last one hoisted won — a delta's
  // rules silently ran the BASE's trivia skipper. Here the base skips only block
  // comments; the delta overrides Doc to also skip `//` line comments. If the
  // delta's Doc gets the base's `_tf0`, the line comment isn't skipped and the
  // second word never parses. (This is exactly how Less line comments broke.)
  const blockTrivia = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))
  const lineTrivia  = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//), regex(/\/\/[^\n]*/))))
  const base  = rules(g => ({ Doc: parser({ trivia: blockTrivia }, many(g.W)), W: regex(/[a-z]+/) }))
  const delta = rules(g => ({ Doc: parser({ trivia: lineTrivia }, many(g.W)) }))

  it('runtime compose(): the delta rule skips line comments, base rule inherited', () => {
    const R = compose([base, delta])
    expect(ok(R.Doc!('a // c\nb', 0, {}))).toBe(8)  // delta trivia skips `// c`
    expect(ok(R.Doc!('a /* c */ b', 0, {}))).toBe(11)
  })

  it('macro build: fused trivia fns are namespaced, line comments skipped, eval-free', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    const src = `import { rules, regex, choice, many, parser, trivia, compose } from 'parseman' with { type: 'macro' }
const blockTrivia = trivia(many(choice(regex(/[ \\t\\n]+/), regex(/\\/\\*[^]*?\\*\\//))))
const lineTrivia = trivia(many(choice(regex(/[ \\t\\n]+/), regex(/\\/\\*[^]*?\\*\\//), regex(/\\/\\/[^\\n]*/))))
const base = rules(g => ({ Doc: parser({ trivia: blockTrivia }, many(g.W)), W: regex(/[a-z]+/) }))
export const grammar = compose([base, rules(g => ({ Doc: parser({ trivia: lineTrivia }, many(g.W)) }))])`
    const out = transformMacro(src, '/pkg/g.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    expect(/new Function/.test(out.code)).toBe(false)
    const g = new Function(out.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn grammar')() as Record<string, (i: string, p: number, c: object) => { ok: boolean; span: { end: number } }>
    // Behavioral guard: if the fused Doc ran the base's (block-only) `_tf0` the
    // `// c` wouldn't be skipped and parsing would stop after `a` (end 1).
    expect(g.Doc!('a // c\nb', 0, {}).span.end).toBe(8)   // line comment skipped by the delta's trivia
  })
})

describe('fusion — structural node() builds through ctx.build across a compose()', () => {
  it('macro: a base with a structural node() composes and builds via ctx.build', async () => {
    const { transformMacro } = await import('../../src/plugin/index.ts')
    // Base ships a structural node() (NO build callback) — it must build via the
    // injected ctx.build host. The delta overrides a leaf. This is the css/less
    // shape (structural node + host); a build-callback-less node() must macro-compile.
    const src = `import { rules, regex, choice, node, compose } from 'parseman' with { type: 'macro' }
const base = rules(g => ({ Item: node('Item', choice(g.Num, g.Word)), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))
export const grammar = compose([base, rules(g => ({ Word: regex(/[A-Z]+/) }))])`
    const out = transformMacro(src, '/pkg/n.ts', new Set(['parseman']))!
    expect(out.warnings).toEqual([])
    expect(/new Function/.test(out.code)).toBe(false)
    const g = new Function(out.code.replace(/^import[^\n]*\n/gm, '').replace(/export const/g, 'var') + '\nreturn grammar')() as Record<string, (i: string, p: number, c: Record<string, unknown>) => { ok: boolean; value: unknown; span: { end: number } }>
    // ctx.build host turns the structural node into a tagged object.
    const built: string[] = []
    const ctx = { build: (type: string) => { built.push(type); return { type } } }
    expect(g.Item!('AB', 0, ctx).span.end).toBe(2)   // delta's Word (override) matches upper-case
    expect(built).toContain('Item')
  })
})

describe('fusion — override (open recursion)', () => {
  it('overriding a rule reroutes a base rule’s own references to it', () => {
    const base = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))
    const over = rules(() => ({ Num: regex(/[0-9]+!/) })) // Num now needs a trailing '!'
    const R = fuseRules([link(base, '_a_'), link(over, '_b_')])
    const ctx = {}
    // base.Value calls the OVERRIDDEN Num (open recursion across artifacts):
    expect(ok(R.Value!('123!', 0, ctx))).toBe(4) // over.Num matches
    expect(ok(R.Value!('123', 0, ctx))).toBe(-1) // over.Num needs '!', Word fails → no match
    expect(ok(R.Value!('abc', 0, ctx))).toBe(3)  // Word still works
  })
})

describe('fusion — à la carte', () => {
  it('pick keeps selected rules + their dependency closure', () => {
    const g = rules(gg => ({
      A: sequence(gg.B, gg.C),
      B: regex(/b/),
      C: regex(/c/),
      Unused: regex(/z/),
    }))
    const p = link(g, '_g_')
    // Picking A pulls in B and C (deps), drops Unused.
    const picked = pick(p, ['A'])
    expect(new Set(picked.keys)).toEqual(new Set(['A', 'B', 'C']))
    const R = fuseRules([picked])
    expect(Object.keys(R).sort()).toEqual(['A', 'B', 'C'])
    expect(ok(R.A!('bc', 0, {}))).toBe(2)
  })

  it('name-closure check throws when a surviving rule references a missing rule', () => {
    // Pick only A but hand-drop its dep B → fuse must reject the dangling ref.
    const g = rules(gg => ({ A: sequence(gg.B, literal('x')), B: regex(/b/) }))
    const p = link(g, '_h_')
    const broken = { ...p, keys: ['A'], ruleFns: new Map([['A', p.ruleFns.get('A')!]]),
      wrappers: new Map([['A', p.wrappers.get('A')!]]), deps: new Map([['A', ['B']]]) }
    expect(() => fuseRules([broken])).toThrow(/missing rule "B"/)
  })
})

describe('fusion — parity with monolithic compile()', () => {
  it('a fused grammar parses identically to the same grammar compiled whole', () => {
    // Recursive nested-list grammar, compiled two ways.
    const mkList = () => rules(g => ({
      List: sequence(literal('['), optional(sepBy(g.Item, literal(','))), literal(']')),
      Item: choice(regex(/[0-9]+/), g.List),
    }))
    const whole = compile(mkList().List)
    const R = fuseRules([link(mkList(), '_l_')])
    const ctx = {}
    for (const s of ['[]', '[1]', '[1,2,3]', '[[1],[2,[3,4]]]', '[1,]', '[', 'x', '[1,[2]]']) {
      const a = whole.parse(s, 0)
      const b = R.List!(s, 0, ctx)
      expect(b.ok, s).toBe(a.ok)
      if (a.ok) expect(b.span.end, s).toBe(a.span.end)
    }
  })

  it('two independently-compiled grammars fuse and interoperate by name', () => {
    // Grammar 1 defines Digits; grammar 2 defines a rule that references Digits
    // by name — they only connect at fuse time.
    const g1 = rules(() => ({ Digits: regex(/[0-9]+/) }))
    const g2 = rules(gg => ({ Tagged: sequence(literal('#'), gg.Digits) }))
    const R = fuseRules([link(g1, '_p_'), link(g2, '_q_')])
    expect(ok(R.Tagged!('#42', 0, {}))).toBe(3)
    expect(ok(R.Tagged!('#', 0, {}))).toBe(-1)
  })
})

describe('fusion — modes over one grammar (RULE_ABI_PLAN §7)', () => {
  const mk = () => rules(g => ({
    Pair: node('Pair', sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/)),
      (_c, _r, s) => ({ kind: 'PairAST', span: s })),
  }))

  it('ctx.build host swaps eval-AST vs positioned-CST on the SAME fused grammar', () => {
    const R = fuseRules([link(mk(), '_m_')])
    // default (no host) → the grammar's own builder (eval AST):
    expect((R.Pair!('a:1', 0, {}).value as { kind: string }).kind).toBe('PairAST')
    // ctx.build host → positioned CST for every node type:
    const cstHost = (type: string, children: readonly unknown[]) =>
      ({ _tag: 'node', type, children: [...children] })
    const v = R.Pair!('a:1', 0, { build: cstHost }).value as { _tag: string; type: string; children: unknown[] }
    expect(v._tag).toBe('node')
    expect(v.type).toBe('Pair')
    expect(v.children).toHaveLength(3)
  })
})

describe('fusion — incremental over a fused map (the map IS the registry)', () => {
  it('parseDoc().edit() re-enters fused rules by name', () => {
    const g = rules(gg => ({
      Obj: node('Obj', sequence(literal('{'), optional(sepBy(gg.Pair, literal(','))), literal('}')),
        (c, _r, s) => ({ _tag: 'node', type: 'Obj', span: s, state: null, children: [...c] })),
      Pair: node('Pair', sequence(gg.Key, literal(':'), gg.Val),
        (c, _r, s) => ({ _tag: 'node', type: 'Pair', span: s, state: null, children: [...c] })),
      Key: node('Key', regex(/[a-z]+/), (c, _r, s) => ({ _tag: 'node', type: 'Key', span: s, state: null, children: [...c] })),
      Val: node('Val', regex(/[0-9]+/), (c, _r, s) => ({ _tag: 'node', type: 'Val', span: s, state: null, children: [...c] })),
    }))
    const R = fuseRules([link(g, '_i_')]) as unknown as Registry<NodeLike>
    const doc = parseDoc(R, 'Obj', '{a:1,b:2}')
    expect(doc.tree).toBeTruthy()
    // Overtype the value '2' at index 7 → '9' (same-length edit re-enters a fused
    // rule by name and grafts).
    const edited = doc.edit(7, 8, '9')
    expect(edited.input).toBe('{a:1,b:9}')
    const fresh = parseDoc(R, 'Obj', edited.input)
    expect(JSON.stringify(edited.tree)).toBe(JSON.stringify(fresh.tree))
  })
})

describe('fusion — the three drivers over one fused map (RULE_ABI_PLAN §7, step 5)', () => {
  // A grammar whose node() builder produces an EVAL AST (not a CST).
  const g = rules(gg => ({
    Sum: node('Sum', sequence(gg.Num, optional(sequence(literal('+'), gg.Num))),
      (c) => ({ kind: 'Sum', terms: c.filter(x => (x as { kind?: string }).kind === 'Num') })),
    Num: node('Num', regex(/[0-9]+/), (_c, _r, s) => ({ kind: 'Num', at: s.start })),
  }))
  const R = fuseRules([link(g, '_d_')]) as unknown as Registry<NodeLike>

  it('eval driver (default build) → the grammar’s eval AST', () => {
    const r = (R.Sum as unknown as (i: string, p: number, c: object) => { ok: boolean; value?: unknown })('1+2', 0, {})
    expect((r.value as { kind: string }).kind).toBe('Sum')
  })

  it('linter/IDE driver (cstBuildHost) → a positioned CST from the SAME grammar', () => {
    // One-shot CST (linter):
    const r = (R.Sum as unknown as (i: string, p: number, c: object) => { ok: boolean; value?: { _tag: string; type: string } })('1+2', 0, { build: cstBuildHost })
    expect(r.value!._tag).toBe('node')
    expect(r.value!.type).toBe('Sum')
    // Incremental CST (IDE): parseDoc threads the same host into every reparse.
    const doc = parseDoc(R, 'Sum', '1+2', { build: cstBuildHost })
    expect((doc.tree as unknown as { _tag: string })._tag).toBe('node')
    const edited = doc.edit(0, 1, '9') // 1+2 -> 9+2
    const fresh = parseDoc(R, 'Sum', '9+2', { build: cstBuildHost })
    expect(JSON.stringify(edited.tree)).toBe(JSON.stringify(fresh.tree))
  })
})
