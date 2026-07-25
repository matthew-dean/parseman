/**
 * `structure-loss` — an earlier `choice` arm that FLATTENS the node a later arm
 * would have structured.
 *
 * The behavioural repro lives in `test/parity/leaf-flattening-arm.test.ts`; this
 * file is the static detector for the same defect, so a grammar author is told
 * before shipping rather than by a downstream tool reporting missing nodes.
 *
 * The negative cases carry the weight here. A finding that says "an arm shadows
 * another" is only useful if it does NOT fire on the ordinary reasons two arms
 * build one node type: disjoint first chars, a runtime gate, or an earlier arm
 * that structures its own value. Each of those is asserted silent, because a
 * diagnostic that fires on all of them is one an author turns off.
 */
import { describe, it, expect } from 'vitest'
import {
  analyzeDuplicationRules, formatDuplicationFindings, duplicationFindingCount,
  choice, sequence, literal, regex, many, oneOrMore, optional, node, leaf, rules, not, noTrivia,
} from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'

const entries = (g: Record<string, Combinator<unknown>>): [string, Combinator<unknown>][] => Object.entries(g)

const propName = regex(/[a-z-]+/)
const numeric = regex(/\d+(?:[a-z]+|%)?/)
const rawWs = regex(/[ \t\n]+/)

/** The Less-grammar shape: a leaf-only "deferred scalar" declaration. */
const flatDecl = (): Combinator<unknown> => node('Declaration', noTrivia(sequence(
  propName, optional(rawWs), literal(':'), optional(rawWs),
  numeric, optional(rawWs), not(regex(/[^\s;}]/)), optional(literal(';')),
)))

describe('structure-loss', () => {
  it('names the flattening arm, the arm it shadows, and the node types deleted', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Flat: flatDecl(),
      Structured: node('Declaration', sequence(
        propName, literal(':'), oneOrMore(r.Dimension), optional(literal(';')),
      )),
      Declaration: choice(r.Flat, r.Structured),
    }))
    const report = analyzeDuplicationRules(entries(g))

    expect(report.structureLoss).toHaveLength(1)
    const f = report.structureLoss[0]!
    expect(f.nodeType).toBe('Declaration')
    expect(f.earlier).toBe(0)
    expect(f.later).toBe(1)
    expect(f.lostNodeTypes).toEqual(['Dimension'])
    expect(f.site.rule).toBe('Declaration')
    expect(f.id).toBe('structure-loss:Declaration:0-1')
    // The overlap is reported as the characters on which the shadowing bites,
    // not as the union of the two arms.
    expect(f.on).toEqual({ kind: 'ranges', ranges: [{ lo: 0x2d, hi: 0x2d }, { lo: 0x61, hi: 0x7a }] })
  })

  it('is silent once the structured arm goes first', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Flat: flatDecl(),
      Structured: node('Declaration', sequence(
        propName, literal(':'), oneOrMore(r.Dimension), optional(literal(';')),
      )),
      Declaration: choice(r.Structured, r.Flat),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss).toEqual([])
  })

  it('follows refs to find the structure — it lives behind `g.valueList`, not in the arm', () => {
    // The whole point: an analysis that stopped at the ref would see a flat arm
    // and a flat arm, and report a grammar with structure as having none.
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      valueList: oneOrMore(r.Dimension),
      Flat: flatDecl(),
      Structured: node('Declaration', sequence(propName, literal(':'), r.valueList)),
      Declaration: choice(r.Flat, r.Structured),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss[0]!.lostNodeTypes).toEqual(['Dimension'])
  })

  it('DISJOINT first chars are not a shadow — the arms are reachable on different input', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      // Led by `@`, so it can never intercept an input the other arm would take.
      Flat: node('Declaration', sequence(literal('@'), propName, literal(':'), numeric)),
      Structured: node('Declaration', sequence(propName, literal(':'), oneOrMore(r.Dimension))),
      Declaration: choice(r.Flat, r.Structured),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss).toEqual([])
  })

  it('DIFFERENT node types are two constructs, not one flattened', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Flat: node('AtRule', sequence(propName, literal(':'), numeric)),
      Structured: node('Declaration', sequence(propName, literal(':'), oneOrMore(r.Dimension))),
      Declaration: choice(r.Flat, r.Structured),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss).toEqual([])
  })

  it('a GATED earlier arm is a deliberate branch, not a shadow', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Flat: flatDecl(),
      Structured: node('Declaration', sequence(
        propName, literal(':'), oneOrMore(r.Dimension), optional(literal(';')),
      )),
      Declaration: choice(
        { gate: (s: unknown) => (s as { fast?: boolean }).fast === true, combinator: r.Flat },
        r.Structured,
      ),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss).toEqual([])
  })

  it('an earlier arm that builds its OWN child nodes is not flattening anything', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Ident: node('Ident', regex(/[a-z]+/)),
      Early: node('Declaration', sequence(propName, literal(':'), r.Ident)),
      Late: node('Declaration', sequence(propName, literal(':'), oneOrMore(r.Dimension))),
      Declaration: choice(r.Early, r.Late),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss).toEqual([])
  })

  it('`leaf()` is opaque — a node wrapped in one produces nothing, and that counts', () => {
    // `leaf()` reduces its interior to a single value on purpose, so the
    // `Dimension` inside it never reaches the tree. Peeling it would make the
    // analysis answer the opposite of the question it is asking.
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Early: node('Declaration', sequence(
        propName, literal(':'), leaf(node('Dimension', numeric), v => v),
      )),
      Late: node('Declaration', sequence(propName, literal(':'), oneOrMore(r.Dimension))),
      Declaration: choice(r.Early, r.Late),
    }))
    expect(analyzeDuplicationRules(entries(g)).structureLoss[0]!.lostNodeTypes).toEqual(['Dimension'])
  })

  it('counts toward the error gate, and `accept` suppresses it by id', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Flat: flatDecl(),
      Structured: node('Declaration', sequence(
        propName, literal(':'), oneOrMore(r.Dimension), optional(literal(';')),
      )),
      Declaration: choice(r.Flat, r.Structured),
      Root: node('Root', many(r.Declaration)),
    }))
    const before = analyzeDuplicationRules(entries(g))
    const after = analyzeDuplicationRules(entries(g), { accept: ['structure-loss:Declaration:0-1'] })

    expect(after.structureLoss).toEqual([])
    expect(duplicationFindingCount(after)).toBe(duplicationFindingCount(before) - 1)
    expect(after.acceptedUnused).toEqual([])
    // A stale acceptance is reported so it can be pruned.
    expect(analyzeDuplicationRules(entries(g), { accept: ['structure-loss:Nope:0-1'] }).acceptedUnused)
      .toEqual(['structure-loss:Nope:0-1'])
  })

  it('formats as a BUG, first, naming what is lost', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Flat: flatDecl(),
      Structured: node('Declaration', sequence(
        propName, literal(':'), oneOrMore(r.Dimension), optional(literal(';')),
      )),
      Declaration: choice(r.Flat, r.Structured),
    }))
    const lines = formatDuplicationFindings(analyzeDuplicationRules(entries(g)))

    expect(lines[0]).toContain('parseman BUG [structure-loss]')
    expect(lines[0]).toContain('arm[0] flattens `Declaration` where arm[1] structures it')
    expect(lines.find(l => l.startsWith('  lost:'))).toBe('  lost: `Dimension`')
    // The suggestion has to say what to DO, and that "fast path" is not a defence.
    expect(lines.find(l => l.startsWith('   fix:'))).toContain('DELETE arm[0] or move it after arm[1]')
  })

  it('reports every shadowed sibling, not just the first', () => {
    const g = rules(r => ({
      Dimension: node('Dimension', numeric),
      Ident: node('Ident', regex(/[a-z]+/)),
      Flat: flatDecl(),
      A: node('Declaration', sequence(propName, literal(':'), oneOrMore(r.Dimension))),
      B: node('Declaration', sequence(propName, literal(':'), r.Ident)),
      Declaration: choice(r.Flat, r.A, r.B),
    }))
    const found = analyzeDuplicationRules(entries(g)).structureLoss
    expect(found.map(f => `${f.earlier}-${f.later}`)).toEqual(['0-1', '0-2'])
    expect(found.map(f => f.lostNodeTypes)).toEqual([['Dimension'], ['Ident']])
  })
})
