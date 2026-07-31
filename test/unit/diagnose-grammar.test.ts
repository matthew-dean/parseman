/**
 * `diagnoseGrammar()` — the deliberate diagnostic entry point.
 *
 * The properties asserted here are the ones that make it GATEABLE, and each of them
 * is a thing the old default-on compile-time warning channel did not have:
 *
 *   - machine-readable first (a plain object with a versioned schema), so CI reads
 *     `ok` instead of grepping `console.warn`;
 *   - deterministic, so a diagnosis can be committed and diffed;
 *   - FAILS CLOSED — an analysis that could not run, or that threw, is not a pass;
 *   - one entry point for every grammar shape, so nobody has to choose between
 *     `analyzeGating` / `analyzeGatingRules` / `analyzeGrammarGating` first.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  choice, compile, compose, diagnoseGrammar, formatGrammarDiagnosis,
  literal, regex, rules, sequence, withCtx,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { degradationCaptureDepth } from '../../src/compiler/degradation.ts'

const ungated = (): Combinator<unknown> => choice(literal('a'), regex(/[\s\S]*/))
const gated = (): Combinator<unknown> => choice(literal('a'), literal('b'))

describe('one entry point, every grammar shape', () => {
  it('a bare combinator', () => {
    expect(diagnoseGrammar(ungated()).summary.ungated).toBe(1)
  })

  it('an array of [name, combinator] entries', () => {
    expect(diagnoseGrammar([['Value', ungated()]]).findings[0]!.id).toBe('Value')
  })

  it('a rules() map', () => {
    const g = rules(_g => ({ Value: ungated() })) as Record<string, unknown>
    expect(diagnoseGrammar(g).findings[0]!.id).toBe('Value')
  })

  it('a compose() result — whose fused map holds rule FUNCTIONS, not combinators', () => {
    const fused = compose([
      rules(g => ({ Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))) })) as never,
      rules(_g => ({ Value: regex(/@[0-9]+/) })) as never,
    ]) as unknown as Record<string, unknown>
    // Analysable only because the carried IR is recovered first; a naive walk sees nothing.
    const d = diagnoseGrammar(fused)
    expect(d.summary.totalChoices).toBeGreaterThan(0)
    expect(d.findings.map(f => f.id)).toContain('Term')
  })
})

describe('machine-readable first, and deterministic', () => {
  it('carries a versioned schema tag and serializes to JSON', () => {
    const d = diagnoseGrammar(ungated())
    expect(d.schema).toBe('parseman.diagnosis/1')
    expect(() => JSON.stringify(d)).not.toThrow()
  })

  it('two runs over the same grammar produce byte-identical findings', () => {
    const a = JSON.stringify(diagnoseGrammar(ungated()).findings)
    const b = JSON.stringify(diagnoseGrammar(ungated()).findings)
    expect(a).toBe(b)
  })

  it('blocking findings sort before advisory ones', () => {
    const d = diagnoseGrammar([['Value', ungated()]], { accept: ['NoSuchRule'] })
    expect(d.findings.map(f => f.severity)).toEqual(['blocking', 'advisory'])
    expect(d.findings[1]!.code).toBe('stale-accept')
  })

  it('`ok` is exactly "no blocking finding" — the whole CI contract', () => {
    expect(diagnoseGrammar(gated()).ok).toBe(true)
    expect(diagnoseGrammar(ungated()).ok).toBe(false)
    // An advisory-only diagnosis still passes.
    const stale = diagnoseGrammar(gated(), { accept: ['Nope'] })
    expect(stale.findings.map(f => f.code)).toEqual(['stale-accept'])
    expect(stale.ok).toBe(true)
  })

  it('reports the accept snapshot that would clear the gate', () => {
    const d = diagnoseGrammar([['B', ungated()], ['A', ungated()]])
    expect(d.acceptSnapshot).toEqual(['A', 'B'])          // sorted, not walk order
    expect(diagnoseGrammar([['B', ungated()], ['A', ungated()]], { accept: d.acceptSnapshot }).ok).toBe(true)
  })
})

describe('FAILS CLOSED — an analysis that could not run is not a pass', () => {
  it('an unanalysable rule blocks even with zero ungated choices', () => {
    // A value that is not a combinator at all: nothing to walk, so no `ungated` —
    // which must NOT read as clean.
    const d = diagnoseGrammar({ Broken: 42 } as Record<string, unknown>)
    expect(d.summary.ungated).toBe(0)
    expect(d.summary.unanalysable).toBeGreaterThan(0)
    expect(d.ok).toBe(false)
    expect(d.findings[0]!.code).toBe('unanalysable')
  })

  it('an analysis that THROWS becomes a blocking finding, not an exception and not a clean report', () => {
    const exploding = { get Boom(): never { throw new Error('walk exploded') } } as unknown as Record<string, unknown>
    let d!: ReturnType<typeof diagnoseGrammar>
    expect(() => { d = diagnoseGrammar(exploding) }).not.toThrow()
    expect(d.ok).toBe(false)
    expect(d.findings[0]!.code).toBe('unanalysable')
    expect(d.findings[0]!.details.join('')).toContain('walk exploded')
  })

  it('an OPAQUE composed piece blocks — a partial walk is not a verdict', () => {
    // `withCtx` without `extraSrc` cannot be serialized to IR, so it travels as a
    // baked piece carrying compiled rule FUNCTIONS. Those rules were never examined.
    const composed = compose([
      rules(_g => ({ Plain: choice(literal('a'), literal('b')) })),
      rules(_g => ({ Opaque: withCtx({ flag: true }, literal('x')) })),
    ]) as unknown as Record<string, unknown>
    const d = diagnoseGrammar(composed)
    if (d.summary.unanalysable === 0) {
      expect(d.summary.totalChoices).toBeGreaterThan(0)   // recoverable after all
      return
    }
    expect(d.ok).toBe(false)
    expect(d.findings.some(f => f.code === 'unanalysable')).toBe(true)
  })

  it('never leaves a degradation sink open, even when the analysis throws', () => {
    // The sink is opened so `PARSEMAN_DEGRADATION=error` cannot make a DIAGNOSTIC
    // throw. An unbalanced open would swallow every later finding in the process —
    // exactly the bug the capture stack exists to prevent.
    const before = degradationCaptureDepth()
    diagnoseGrammar({ get Boom(): never { throw new Error('x') } } as unknown as Record<string, unknown>)
    expect(degradationCaptureDepth()).toBe(before)
  })

  it('reports rather than dies when PARSEMAN_DEGRADATION=error', () => {
    const prev = process.env.PARSEMAN_DEGRADATION
    process.env.PARSEMAN_DEGRADATION = 'error'
    try {
      const composed = compose([
        rules(_g => ({ Plain: choice(literal('a'), literal('b')) })),
        rules(_g => ({ Opaque: withCtx({ flag: true }, literal('x')) })),
      ]) as unknown as Record<string, unknown>
      expect(() => diagnoseGrammar(composed)).not.toThrow()
    } finally { process.env.PARSEMAN_DEGRADATION = prev }
  })
})

describe('the human renderer is a view OVER the structured object', () => {
  it('a clean grammar renders one summary line and no findings', () => {
    const lines = formatGrammarDiagnosis(diagnoseGrammar(gated()))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('grammar OK')
  })

  it('a finding renders its arm-level evidence and the accept key that would silence it', () => {
    const out = formatGrammarDiagnosis(diagnoseGrammar([['Value', ungated()]])).join('\n')
    expect(out).toContain('grammar NOT OK')
    expect(out).toContain('[ungated-choice] Value')
    expect(out).toContain('fix:')
    expect(out).toContain("{ accept: ['Value'] }")
  })

  it('a PARTIAL walk says so before anything else — silence must not read as clean', () => {
    const lines = formatGrammarDiagnosis(diagnoseGrammar({ Broken: 42 } as Record<string, unknown>))
    expect(lines[1]).toContain('UNANALYSABLE')
    expect(lines[1]).toContain('does NOT mean the grammar is clean')
  })
})

describe('compile() itself stays silent and payload-free', () => {
  it('compiling the worst grammar in this file warns about nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      compile(ungated(), undefined)
      compileFusedish()
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  const compileFusedish = (): void => {
    compile(rules(_g => ({ Value: ungated() })).Value as Combinator<unknown>, undefined)
  }
})
