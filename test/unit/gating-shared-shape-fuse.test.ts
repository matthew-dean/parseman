/**
 * WHERE the gating diagnostic asks its question.
 *
 * A SHARED SHAPE is a `rules()` map referencing a rule it does not define
 * (`g.Value`). Every first-set through that hole reads `any`, so the shape module
 * looks like it holds an ungated choice — but the shape is never executed as a
 * parser, its author cannot fix the hole, and the configuration that finding
 * describes never runs. Meanwhile the artifact that IS executed — the fused
 * consumer, whose binding decides the answer, and whose author CAN act — was never
 * analyzed at all.
 *
 * So the pre-fix behaviour was inverted in both directions at once: a false positive
 * at the shape site AND a false negative at the fuse site. These tests pin BOTH, so
 * that muting the shape finding (which would hide the false negative — the more
 * damaging half) cannot pass.
 *
 * WHAT CHANGED IN 0.45.0: the question is no longer asked as a side effect of
 * building. `compile()`, `compileRuleMap()`, `compose()` and the macro transform
 * report NOTHING; `diagnoseGrammar()` asks, deliberately. So the "which build site
 * prints it" half of these tests is gone — replaced by a hard pin that NO build site
 * prints — and the defer/answer semantics they exist to protect are asserted where
 * they actually live: in the report.
 */
import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  analyzeGatingRules, choice, compose, diagnoseGrammar, literal, ref, regex, rules, sequence,
} from '../../src/index.ts'
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
 *  verdict is entirely local — nothing about it is deferred. */
const ORDINARY = `
import { choice, literal, regex, rules } from 'parseman' with { type: 'macro' }
export const base = rules(_g => ({ Pick: choice(literal('a'), regex(/[\\s\\S]/)) }))
`

/** The shape and its binding, as runtime values — the same grammar the macro sources
 *  above describe, in the form `diagnoseGrammar` can be pointed at. */
const shapeRules = (): Record<string, unknown> => rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
})) as Record<string, unknown>

const bound = (valueRegex: RegExp): Record<string, unknown> => compose([
  shapeRules() as never,
  rules(_g => ({ Value: regex(valueRegex) })) as never,
]) as Record<string, unknown>

/**
 * Run `fn` capturing EVERY console line it emits. Nothing in the build path may
 * write one any more — the old harness had to force `PARSEMAN_GATING=warn` here,
 * and that env var no longer exists.
 */
const capture = <T>(fn: () => T): { value: T; warns: string[] } => {
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
  try { return { value: fn(), warns } } finally { spy.mockRestore() }
}

/** The headline findings only — one per reported choice, so counting them counts findings. */
const ungatedIds = (g: Record<string, unknown>): string[] =>
  diagnoseGrammar(g).findings.filter(f => f.code === 'ungated-choice').map(f => f.id)

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

describe('no build site reports gating — at all', () => {
  it('building a shared shape prints nothing', () => {
    withPackage({ shape: SHAPE }, (_dir, warns) => { expect(warns).toEqual([]) })
  })

  it('building an ORDINARY grammar with a real, local, unambiguous finding prints nothing', () => {
    // This is the case that used to justify the whole warn channel: no hole, no
    // deferral, a genuine cliff the author can fix. It is STILL a finding — see the
    // diagnosis assertion below — it is just not shouted at a build log nobody read.
    withPackage({ base: ORDINARY }, (_dir, warns) => { expect(warns).toEqual([]) })
    expect(ungatedIds(rules(_g => ({ Pick: choice(literal('a'), regex(/[\s\S]/)) })) as Record<string, unknown>))
      .toEqual(['Pick'])
  })

  it('a compose() that BREAKS gating prints nothing at either site, macro or runtime', () => {
    withPackage({ shape: SHAPE }, (dir, shapeWarns) => {
      expect(shapeWarns).toEqual([])
      const macro = capture(() =>
        transformMacro(consumer(String.raw`/@[0-9]+/`), path.join(dir, 'bad.ts'), new Set(['parseman']))!)
      expect(macro.warns).toEqual([])
      expect(macro.value.warnings).toEqual([])
      expect(capture(() => bound(/@[0-9]+/)).warns).toEqual([])
    })
  })

  it('a same-file compose() and a composeLeaf() print nothing either', () => {
    const sameFile = `
import { choice, compose, literal, regex, rules, sequence } from 'parseman' with { type: 'macro' }
const shape = rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
}))
export const parser = compose([shape, rules(_g => ({ Value: regex(/@[0-9]+/) }))])
`
    expect(capture(() => transformMacro(sameFile, '/pkg/bad.ts', new Set(['parseman']))!).warns).toEqual([])

    withPackage({ shape: SHAPE }, (dir, _w) => {
      const leaf = `
import { composeLeaf, node, regex, rules } from 'parseman' with { type: 'macro' }
import { shape } from './shape.js'
export const parser = composeLeaf([shape, rules(g => ({
  Value: regex(/@[0-9]+/),
  Document: node('Document', g.Term, (children, _fields, span) => ({ type: 'Term', parts: children.map(c => c.value), span })),
}))])
`
      expect(capture(() => transformMacro(leaf, path.join(dir, 'leaf-bad.ts'), new Set(['parseman']))).warns).toEqual([])
    })
  })
})

describe('the shape site defers — its own hole is not its verdict to give', () => {
  it('a shared shape has NO ungated finding for a choice ungated only by its hole', () => {
    expect(ungatedIds(shapeRules())).toEqual([])
    expect(diagnoseGrammar(shapeRules()).ok).toBe(true)
  })

  it('…and the hole is still visible programmatically, as `deferred` rather than `ungated`', () => {
    const shape = shapeRules() as Record<string, Combinator<unknown>>
    const r = analyzeGatingRules(Object.entries(shape))
    const term = r.choices.find(c => c.rule === 'Term')!
    expect(term.gates).toBe('no')          // it genuinely does not gate AS WRITTEN HERE
    expect(term.deferred).toBe(true)       // …but the verdict is not this artifact's
    expect(term.anyArms.map(a => a.unresolvedExternal)).toEqual([true])
    expect(r.ungated).toEqual([])          // so nothing is reported or gate-failed
    expect(r.deferred.map(c => c.id)).toEqual(['Term'])
    // The diagnosis surfaces the deferral in its summary rather than as a finding.
    expect(diagnoseGrammar(shape).summary.deferred).toBe(1)
  })

  it('a NON-hole finding in the same shape is still reported at the shape site', () => {
    // Guard against over-muting: only the hole is deferred, not the whole map.
    expect(ungatedIds(rules(g => ({
      Term: choice(sequence(g.Value as Combinator<unknown>, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
      Local: choice(literal('a'), regex(/[\s\S]/)),
    })) as Record<string, unknown>)).toEqual(['Local'])
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
  it('a binding that GATES the fused choice diagnoses clean', () => {
    // `[0-9]` is disjoint from arm[1]'s `'@'`, so the fused choice DOES gate.
    const d = diagnoseGrammar(bound(/[0-9]+/))
    expect(d.findings).toEqual([])
    expect(d.ok).toBe(true)
  })

  it('a binding that BREAKS gating is reported at the FUSE site, named by rule', () => {
    // `@[0-9]+` collides with arm[1]'s `'@'` — the fused choice genuinely cannot gate.
    const d = diagnoseGrammar(bound(/@[0-9]+/))
    expect(d.ok).toBe(false)
    const term = d.findings.find(f => f.code === 'ungated-choice')!
    expect(term.id).toBe('Term')
    // The finding is the REAL post-binding cause (a concrete overlap on '@'), not the
    // shape's "unresolved ref g.Value" non-answer.
    const detail = term.details.join('\n')
    expect(detail).toContain("arm[0] ∩ arm[1] overlap on '@'")
    expect(detail).not.toContain('unresolved ref')
  })

  it('exactly ONE finding per real cliff — asking once cannot double-report', () => {
    // The old failure mode was structural: both the authoring site and every fuse
    // printed. With a single deliberate call there is one report by construction, and
    // an ordinary hole-free rule appears in it exactly once.
    const composed = compose([
      rules(_g => ({ Pick: choice(literal('a'), regex(/[\s\S]/)) })) as never,
      rules(_g => ({ Other: literal('z') })) as never,
    ]) as Record<string, unknown>
    expect(ungatedIds(composed)).toEqual(['Pick'])
  })
})
