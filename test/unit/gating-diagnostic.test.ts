/**
 * Static first-char gating diagnostic (src/analysis/gating.ts) and its SEPARATION
 * from compile().
 *
 * The wiring assertions below used to say the opposite: that `compile()` runs the
 * analysis by default and prints it. It did, and that was the bug — importing one
 * example grammar emitted 51 `console.warn` lines of advice nobody asked for, before
 * a byte was parsed. Producing an artifact and reporting on it are two different acts;
 * `diagnoseGrammar()` is the second one. These tests now PIN the silence, so the
 * advice cannot drift back into the compile path unnoticed.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  analyzeGating, formatGatingWarnings, compile, diagnoseGrammar,
  choice, sequence, literal, regex, not, rules, dispatch, when, otherwise,
  startsWith,
} from '../../src/index.ts'
import { Stylesheet } from '../../examples/css/parser.ts'

describe('analyzeGating — classification', () => {
  it('a disjoint literal choice GATES (yes), no warnings', () => {
    const g = choice(literal('a'), literal('b'), literal('c'))
    const r = analyzeGating(g)
    expect(r.choices).toHaveLength(1)
    expect(r.choices[0]!.gates).toBe('yes')
    expect(r.ungated).toHaveLength(0)
    expect(formatGatingWarnings(r)).toHaveLength(0)
  })

  it('a broad-regex arm makes the choice UNGATED (no) with cause broad-recognizer', () => {
    const g = choice(literal('a'), regex(/[\s\S]*/))
    const r = analyzeGating(g)
    const c = r.choices[0]!
    expect(c.gates).toBe('no')
    expect(r.ungated).toHaveLength(1)
    expect(c.anyArms).toHaveLength(1)
    expect(c.anyArms[0]!.cause).toBe('broad-recognizer')
    expect(formatGatingWarnings(r).join('\n')).toContain('UNGATED')
  })

  it('finite overlapping arms are UNGATED with an overlap finding', () => {
    const g = choice(
      sequence(literal('ab'), literal('c')),
      sequence(literal('ad'), literal('e')),
    )
    const r = analyzeGating(g)
    const c = r.choices[0]!
    expect(c.gates).toBe('no')
    expect(c.overlaps.length).toBeGreaterThanOrEqual(1)
    expect(c.anyArms).toHaveLength(0)
  })

  it('refs that DEEP-resolve disjoint are RECOVERABLE, not warned', () => {
    const { v } = rules((g) => ({
      v: choice(g.a, g.b),
      a: literal('x'),
      b: literal('y'),
    }))
    const r = analyzeGating(v as import('../../src/index.ts').Combinator<unknown>)
    const vchoice = r.choices.find(c => c.anyArms.length === 0 && c.overlaps.length === 0)!
    expect(vchoice.gates).toBe('recoverable')
    expect(r.ungated).toHaveLength(0)
    expect(formatGatingWarnings(r)).toHaveLength(0)
  })

  it('the accept allowlist moves an ungated choice to `accepted` (silent) by id', () => {
    const g = choice(literal('a'), regex(/[\s\S]*/))
    const id = analyzeGating(g).choices[0]!.id      // '<entry>' for a bare entry choice
    const r = analyzeGating(g, { accept: [id] })
    expect(r.choices[0]!.gates).toBe('no')          // still classified ungated
    expect(r.choices[0]!.accepted).toBe(true)
    expect(r.ungated).toHaveLength(0)               // excluded from warnings + gate
    expect(r.accepted).toHaveLength(1)
    expect(formatGatingWarnings(r)).toHaveLength(0)
  })

  it('assigns stable ids: bare rule when unique, rule#N when a rule has several', () => {
    const { top } = rules(() => ({
      // two anonymous choices under `top` → top#0, top#1
      top: sequence(choice(literal('a'), regex(/[\s\S]*/)), choice(literal('b'), regex(/[\s\S]*/))),
    }))
    const ids = analyzeGating(top as import('../../src/index.ts').Combinator<unknown>).choices.map(c => c.id)
    expect(ids).toContain('top#0')
    expect(ids).toContain('top#1')
  })

  it('reports acceptedUnused for stale snapshot entries', () => {
    const g = choice(literal('a'), literal('b'))   // gated → nothing to accept
    const r = analyzeGating(g, { accept: ['no-such-choice'] })
    expect(r.acceptedUnused).toEqual(['no-such-choice'])
  })

  it('walks choices inside dispatch tails', () => {
    const g = dispatch(
      literal('@media'),
      when('@media', choice(literal('{'), regex(/[\s\S]*/))),
      otherwise(choice(literal(';'), regex(/[\s\S]*/))),
    )
    const r = analyzeGating(g)
    expect(r.choices).toHaveLength(2)
    expect(r.ungated).toHaveLength(2)
    expect(r.ungated[0]!.rule).toBe('<entry>')
  })

  it('walks the selector, exact when(), matcher when(), and otherwise() arms', () => {
    const g = dispatch(
      choice(literal('@'), regex(/[\s\S]*/)),
      when('@media', choice(literal('{'), regex(/[\s\S]*/))),
      when(startsWith('@-'), choice(literal('v'), regex(/[\s\S]*/))),
      otherwise(choice(literal(';'), regex(/[\s\S]*/))),
    )
    const r = analyzeGating(g)

    expect(r.choices).toHaveLength(4)
    expect(r.ungated).toHaveLength(4)
  })
})

describe('analyzeGating — anti-pattern lints', () => {
  it('flags not(not(...)) faking first-char gating', () => {
    const g = choice(sequence(not(not(literal('x'))), literal('y')), literal('z'))
    const r = analyzeGating(g)
    const ap = r.antiPatterns.find(a => a.kind === 'double-not')
    expect(ap).toBeDefined()
    expect(formatGatingWarnings(r).join('\n')).toContain('MISCOMPILES')
  })

  it('flags a leading not(...) on a choice arm', () => {
    const g = choice(sequence(not(literal('/*')), literal('a')), literal('b'))
    const r = analyzeGating(g)
    expect(r.antiPatterns.some(a => a.kind === 'leading-not')).toBe(true)
  })

  it('suggests word()/keywords() for a bare leading keyword regex', () => {
    const g = choice(sequence(regex(/color/), literal(':')), literal('x'))
    const r = analyzeGating(g)
    const ap = r.antiPatterns.find(a => a.kind === 'keyword-regex')
    expect(ap).toBeDefined()
    expect(ap!.message).toContain('word(')
  })
})

describe('analyzeGating — real css example', () => {
  it('value choice: anyValue arm is a cross-artifact-ref cause + Dimension/Num overlap', () => {
    const r = analyzeGating(Stylesheet)
    const value = r.choices.find(c => c.rule === 'value' && c.anyArms.length > 0)!
    expect(value.gates).toBe('no')
    expect(value.anyArms.some(a => a.cause === 'cross-artifact-ref' && a.detail.includes('anyValue'))).toBe(true)
    expect(value.overlaps.length).toBeGreaterThanOrEqual(1) // Dimension ∩ Num
  })

  it('at least one choice is gated and at least one is genuinely ungated', () => {
    const r = analyzeGating(Stylesheet)
    expect(r.gated).toBeGreaterThanOrEqual(1)
    expect(r.ungated.length).toBeGreaterThanOrEqual(1)
  })
})

describe('compile() is silent — the diagnostic is a separate, deliberate call', () => {
  const broad = choice(literal('a'), regex(/[\s\S]*/))

  it('compiling a genuinely-ungated grammar warns about NOTHING', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    compile(broad, undefined)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('compiling a genuinely-ungated grammar never throws, at any env level', () => {
    const prev = process.env.PARSEMAN_GATING
    process.env.PARSEMAN_GATING = 'error'   // the var no longer exists; nothing may read it
    try { expect(() => compile(broad, undefined)).not.toThrow() }
    finally { process.env.PARSEMAN_GATING = prev }
  })

  it('the compiled artifact carries no diagnostic payload', () => {
    expect('gating' in compile(broad, undefined)).toBe(false)
  })

  it('diagnoseGrammar finds exactly what compile() used to print', () => {
    const d = diagnoseGrammar(broad)
    expect(d.ok).toBe(false)
    expect(d.summary.ungated).toBeGreaterThanOrEqual(1)
    expect(d.findings.some(f => f.code === 'ungated-choice')).toBe(true)
  })

  it('the accept allowlist clears the gate, and reports the snapshot key that would', () => {
    const id = analyzeGating(broad).choices[0]!.id
    expect(diagnoseGrammar(broad).acceptSnapshot).toContain(id)
    const accepted = diagnoseGrammar(broad, { accept: [id] })
    expect(accepted.ok).toBe(true)
    expect(accepted.summary.ungated).toBe(0)
    expect(accepted.summary.accepted).toBe(1)
  })

  it('a gated grammar diagnoses clean', () => {
    const d = diagnoseGrammar(choice(literal('a'), literal('b')))
    expect(d.ok).toBe(true)
    expect(d.findings).toHaveLength(0)
  })
})
