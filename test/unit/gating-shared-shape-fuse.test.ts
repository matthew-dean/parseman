/**
 * WHERE the gating diagnostic asks its question.
 *
 * A SHARED SHAPE is a `rules()` map referencing a rule it does not define
 * (`g.Value`). Every first-set through that hole reads `any`, so the shape module
 * looks like it holds an ungated choice — but the shape is never executed as a
 * parser, its author cannot fix the hole, and the configuration the warning
 * describes never runs. Meanwhile the artifact that IS executed — the fused
 * consumer, whose binding decides the answer, and whose author CAN act — was never
 * analyzed at all.
 *
 * So the pre-fix behaviour was inverted in both directions at once: a false positive
 * at the shape site AND a false negative at the fuse site. These tests pin BOTH, so
 * that muting the shape warning (which would hide the false negative — the more
 * damaging half) cannot pass.
 *
 * Gating warnings go to `console.warn`, NOT to `transformMacro(...).warnings`
 * (which carries lowering/fallback diagnostics). Capture the former.
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { analyzeGatingRules, choice, compose, literal, ref, regex, rules, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'

/**
 * `Term` gates iff `Value`'s first chars are disjoint from `'@'`. The shape cannot
 * know: `g.Value` is a hole here. Only a consumer's binding decides.
 */
const SHAPE = `
import { choice, literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }
export const shape = rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
}))
`

const consumer = (valueRegex: string): string => `
import { compose, regex, rules } from 'parseman' with { type: 'macro' }
import { shape } from './shape.js'
export const parser = compose([shape, rules(g => ({ Value: regex(${valueRegex}) }))])
`

/** An ORDINARY grammar: a genuinely-ungated choice with no hole anywhere. Its
 *  verdict is entirely local, so exactly one site may report it. */
const ORDINARY = `
import { choice, literal, regex, rules } from 'parseman' with { type: 'macro' }
export const base = rules(_g => ({ Pick: choice(literal('a'), regex(/[\\s\\S]/)) }))
`

/** Run `fn` with the gating diagnostic ON (the suite defaults it off — see
 *  vitest.config.ts), capturing every `console.warn` line it emits. */
const capture = <T>(fn: () => T): { value: T; warns: string[] } => {
  const warns: string[] = []
  const prev = process.env.PARSEMAN_GATING
  process.env.PARSEMAN_GATING = 'warn'
  const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
  try { return { value: fn(), warns } } finally { spy.mockRestore(); process.env.PARSEMAN_GATING = prev }
}

/** The headline lines only — one per reported choice, so counting them counts findings. */
const findings = (warns: string[]): string[] => warns.filter(w => w.includes('is UNGATED'))

/** Emit `sources` (keys are file names) into a throwaway package and run `body`. */
const withPackage = <T>(sources: Record<string, string>, body: (dir: string, warns: string[]) => T): T => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-gating-fuse-'))
  try {
    const emit = capture(() => {
      for (const [name, source] of Object.entries(sources)) {
        const out = transformMacro(source, path.join(dir, `${name}.ts`), new Set(['parseman']))
        if (!out) throw new Error(`transformMacro returned null for ${name}`)
        fs.writeFileSync(path.join(dir, `${name}.js`), out.code)
      }
    })
    return body(dir, emit.warns)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('the shape site defers — it does not warn about its own hole', () => {
  it('a shared shape emits NO gating warning for a choice ungated only by its hole', () => {
    withPackage({ shape: SHAPE }, (_dir, warns) => {
      expect(warns).toEqual([])
    })
  })

  it('…and the hole is still visible programmatically, as `deferred` rather than `ungated`', () => {
    const shape = rules(g => ({
      Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
    })) as Record<string, Combinator<unknown>>
    const r = analyzeGatingRules(Object.entries(shape))
    const term = r.choices.find(c => c.rule === 'Term')!
    expect(term.gates).toBe('no')          // it genuinely does not gate AS WRITTEN HERE
    expect(term.deferred).toBe(true)       // …but the verdict is not this artifact's
    expect(term.anyArms.map(a => a.unresolvedExternal)).toEqual([true])
    expect(r.ungated).toEqual([])          // so nothing is warned or gate-failed
    expect(r.deferred.map(c => c.id)).toEqual(['Term'])
  })

  it('a NON-hole finding in the same shape still warns at the shape site', () => {
    // Guard against over-muting: only the hole is deferred, not the whole map.
    withPackage({
      shape: `
import { choice, literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }
export const shape = rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
  Local: choice(literal('a'), regex(/[\\s\\S]/)),
}))
`,
    }, (_dir, warns) => {
      expect(findings(warns)).toEqual([
        'parseman gating: choice @ Local is UNGATED [greedyClassify] — no first-char dispatch; every position speculatively enters doomed arms.',
      ])
    })
  })

  it('an UNNAMED unresolved ref() is NOT a hole — nobody can bind it, so it stays local', () => {
    const orphan = ref<unknown>()
    const r = analyzeGatingRules([['R', choice(sequence(orphan, literal('/')), literal('@'))]])
    const c = r.choices[0]!
    expect(c.anyArms[0]!.cause).toBe('cross-artifact-ref')
    expect(c.anyArms[0]!.unresolvedExternal).toBe(false)
    expect(c.deferred).toBe(false)
    expect(r.ungated.map(x => x.id)).toEqual(['R'])
  })
})

describe('the fuse site answers — with the hole bound', () => {
  it('a binding that GATES the fused choice produces no warning anywhere', () => {
    withPackage({ shape: SHAPE }, (dir, shapeWarns) => {
      expect(shapeWarns).toEqual([])
      // `[0-9]` is disjoint from arm[1]'s `'@'`, so the fused choice DOES gate.
      const { value, warns } = capture(() =>
        transformMacro(consumer('/[0-9]+/'), path.join(dir, 'ok.ts'), new Set(['parseman']))!)
      expect(warns).toEqual([])
      expect(value.code).not.toMatch(/\bcompose\s*\(\s*\[/)   // really fused, not deferred to runtime
    })
  })

  it('a binding that BREAKS gating warns AT THE FUSE SITE, named by rule', () => {
    withPackage({ shape: SHAPE }, (dir, shapeWarns) => {
      expect(shapeWarns).toEqual([])
      // `@[0-9]+` collides with arm[1]'s `'@'` — the fused choice genuinely cannot gate.
      const { warns } = capture(() =>
        transformMacro(consumer(String.raw`/@[0-9]+/`), path.join(dir, 'bad.ts'), new Set(['parseman']))!)
      expect(findings(warns)).toEqual([
        'parseman gating: choice @ Term is UNGATED [firstMatch] — no first-char dispatch; every position speculatively enters doomed arms.',
      ])
      // The finding is the REAL post-binding cause (a concrete overlap on '@'), not the
      // shape's "unresolved ref g.Value" non-answer.
      expect(warns.some(w => w.includes("arm[0] ∩ arm[1] overlap on '@'"))).toBe(true)
      expect(warns.some(w => w.includes('unresolved ref'))).toBe(false)
    })
  })

  it('the same two directions hold for a same-file compose() of a local shape', () => {
    const src = (valueRegex: string): string => `
import { choice, compose, literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const shape = rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
}))
export const parser = compose([shape, rules(_g => ({ Value: regex(${valueRegex}) }))])
`
    const ok = capture(() => transformMacro(src('/[0-9]+/'), '/pkg/ok.ts', new Set(['parseman']))!)
    expect(ok.warns).toEqual([])
    const bad = capture(() => transformMacro(src(String.raw`/@[0-9]+/`), '/pkg/bad.ts', new Set(['parseman']))!)
    expect(findings(bad.warns)).toEqual([
      'parseman gating: choice @ Term is UNGATED [firstMatch] — no first-char dispatch; every position speculatively enters doomed arms.',
    ])
  })

  it('composeLeaf answers too — its local leaf map is what binds the hole', () => {
    withPackage({ shape: SHAPE }, (dir, shapeWarns) => {
      expect(shapeWarns).toEqual([])
      const leaf = (valueRegex: string): string => `
import { composeLeaf, node, regex, rules } from 'parseman' with { type: 'macro' }
import { shape } from './shape.js'
export const parser = composeLeaf([shape, rules(g => ({
  Value: regex(${valueRegex}),
  Document: node('Document', g.Term, (children, _fields, span) => ({ type: 'Term', parts: children.map(c => c.value), span })),
}))])
`
      expect(capture(() => transformMacro(leaf('/[0-9]+/'), path.join(dir, 'leaf-ok.ts'), new Set(['parseman']))).warns).toEqual([])
      const bad = capture(() => transformMacro(leaf(String.raw`/@[0-9]+/`), path.join(dir, 'leaf-bad.ts'), new Set(['parseman'])))
      expect(findings(bad.warns)).toEqual([
        'parseman gating: choice @ Term is UNGATED [firstMatch] — no first-char dispatch; every position speculatively enters doomed arms.',
      ])
    })
  })

  it('the RUNTIME compose() path answers as well (no macro involved)', () => {
    const bind = (value: Combinator<unknown>): unknown => compose([
      rules(g => ({ Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))) })) as never,
      rules(_g => ({ Value: value })) as never,
    ])
    expect(capture(() => bind(regex(/[0-9]+/))).warns).toEqual([])
    expect(findings(capture(() => bind(regex(/@[0-9]+/))).warns)).toEqual([
      'parseman gating: choice @ Term is UNGATED [firstMatch] — no first-char dispatch; every position speculatively enters doomed arms.',
    ])
  })
})

describe('no double-reporting for ordinary, hole-free grammars', () => {
  it('an ordinary ungated choice warns exactly ONCE when its module is built', () => {
    withPackage({ base: ORDINARY }, (_dir, warns) => {
      expect(findings(warns)).toEqual([
        'parseman gating: choice @ Pick is UNGATED [greedyClassify] — no first-char dispatch; every position speculatively enters doomed arms.',
      ])
    })
  })

  it('…and still exactly ONCE when a compose() in the SAME file fuses it', () => {
    // Both sites see this map: `compileRuleMap` (authoring) and the fuse. Only the
    // authoring site may report it — the fuse reports solely what was DEFERRED.
    const { warns } = capture(() => transformMacro(`
import { choice, compose, literal, regex, rules } from 'parseman' with { type: 'macro' }
const base = rules(_g => ({ Pick: choice(literal('a'), regex(/[\\s\\S]/)) }))
export const parser = compose([base, rules(_g => ({ Other: literal('z') }))])
`, '/pkg/same-file.ts', new Set(['parseman']))!)
    expect(findings(warns)).toEqual([
      'parseman gating: choice @ Pick is UNGATED [greedyClassify] — no first-char dispatch; every position speculatively enters doomed arms.',
    ])
  })

  it('…and exactly ONCE across a package boundary (base module + consuming compose)', () => {
    withPackage({ base: ORDINARY }, (dir, baseWarns) => {
      // Reported when the BASE module is built…
      expect(findings(baseWarns)).toHaveLength(1)
      // …and not again by the consumer that fuses it.
      const { warns } = capture(() => transformMacro(`
import { compose, literal, rules } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
export const parser = compose([base, rules(_g => ({ Other: literal('z') }))])
`, path.join(dir, 'consumer.ts'), new Set(['parseman']))!)
      expect(findings(warns)).toEqual([])
    })
  })
})
