/**
 * A routed arm gate that reads TWO characters (`OP_RGATE2`).
 *
 * Jess's Less statement reads its name once and routes it; the spaced
 * declaration arm then wants `routed()` and a colon a gap follows,
 * `regex(/:(?=[ \t…])/)`. A one-character gate admits every `:`, so each glued
 * head (`div:hover`, `color:red`) entered the arm and failed at the colon. The
 * regex says its second character outright, so the gate tests it too, with no
 * scan, and reports the colon's set where entering the arm would.
 *
 * The reference driver tests the first character only. Every reader must give
 * the interpreter's whole RunResult, accepting and failing.
 */
import { describe, expect, it } from 'vitest'
import { choice, dispatch, endsWith, label, literal, many, node, otherwise, parser, regex, routed, rules, sequence, when } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { countSiteVisits } from '../../src/table/assemble.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { run } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { OP_RGATE2 } from '../../src/table/ops.ts'
import { readers, seeded } from '../helpers/table-readers.ts'

type Comb = Combinator<unknown>


const value = regex(/[a-z0-9]+/)
const ws = regex(/[ \t]+/)
// A local const, as Jess's arm is: the gate walk does not follow rule references.
// Two spellings of the gap after the colon: ASCII only, and one with a non-ASCII
// space, which takes the engines' class path rather than their ASCII tables.
const makeSheet = (colon: RegExp): Record<string, Comb> => {
const spacedColon = label('":"', regex(colon))
const spaced = node('Spaced', sequence(parser({ trivia: ws }, sequence(routed(), spacedColon)), value, literal(';')), c => ({ spaced: c }))
const sheet = rules({ trivia: regex(/[ \t\n]+/) }, (g: Record<string, Comb>) => ({
  Sheet: many(g.Statement!),
  Statement: dispatch(regex(/[a-z]+\(?/),
    when(endsWith('('), node('Call', sequence(routed(), value, literal(')'), literal(';')), c => ({ call: c }))),
    otherwise(choice(
      spaced,
      node('Rule', sequence(regex(/[a-z]+(?::[a-z]+)?/), literal('{'), literal('}')), c => ({ rule: c })),
      node('Decl', sequence(regex(/[a-z]+/), literal(':'), value, literal(';')), c => ({ decl: c })),
    ), { commit: false })),
})) as Record<string, Comb>
return sheet
}
const sheets = { ascii: makeSheet(/:(?=[ \t])/), unicode: makeSheet(/:(?=[ \t\u00a0])/) }

function inputs(): string[] {
  const rnd = seeded(5)
  const stmt = (): string => [
    () => 'div:hover{}', () => 'a{}', () => 'color:red;', () => 'color: red;', () => 'color :\tred;',
    () => 'color:\tred;', () => 'f(x);', () => 'x :y;', () => 'p :hover{}', () => 'a:\u00a0b;',
  ][rnd(10)]!()
  const out = ['div:hover{}', 'color:red;', 'color: red;', 'a:', 'a: ', 'a:\t1;', 'a :', 'a', '', 'a:b', 'f(', 'a:{}']
  for (let i = 0; i < 200; i++) {
    const ok = Array.from({ length: 1 + rnd(4) }, stmt).join(' ')
    out.push(ok)
    const at = rnd(ok.length)
    out.push([ok.slice(0, at), `${ok.slice(0, at)}?${ok.slice(at)}`, ok.slice(0, at) + ok.slice(at + 1)][rnd(3)]!)
  }
  return out
}

describe('a routed arm gate that reads two characters', () => {
  for (const [kind, sheet] of Object.entries(sheets)) {
  it(`(${kind}) gates the spaced declaration on the colon and the gap after it`, () => {
    const prog = encodeTable(sheet)
    expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_RGATE2)).toHaveLength(1)
    const gate = [...reachableIps(prog)].find(ip => prog.code[ip] === OP_RGATE2)!
    const arm = prog.code[gate + 2]!
    const glued = countSiteVisits(prog, rs => { run(rs.Sheet!, 'div:hover{} color:red;') })
    expect(glued[gate]).toBe(2)
    expect(glued[arm]).toBe(0)
    const spacedHit = countSiteVisits(prog, rs => { run(rs.Sheet!, 'color: red;') })
    expect(spacedHit[arm]).toBe(1)
  })

  for (const tolerant of [false, true]) {
  it(`(${kind}) parses and fails as the interpreter does in every reader${tolerant ? ' (tolerant)' : ''}`, () => {
    // 328 distinct of 412 generated: statements are drawn from ten spellings.
    const cases = [...new Set(inputs())]
    expect(cases.length).toBeGreaterThan(300)
    const opts = tolerant ? { tolerant: true } : {}
    const want = cases.map(input => digestValue(run(sheet.Sheet!, input, opts)))
    for (const [name, entries] of readers(encodeTable(sheet))) {
      cases.forEach((input, i) => {
        expect(digestValue(run(entries.Sheet!, input, opts)), `${name} ${JSON.stringify(input)}`).toBe(want[i])
      })
    }
  }, 60_000)
  }
  }

  // The second character is read as a code point (`lead`): an astral one is
  // two code units, so its set is of code points too.
  it('reads an astral second character as one code point', () => {
    for (const next of [literal('-😀'), regex(/-😀/), regex(/-😀/u), regex(/-[😀😁]/u)]) {
      const g = rules({ trivia: regex(/[ ]+/) }, (g: Record<string, Comb>) => ({
        S: many(g.St!),
        St: dispatch(regex(/[a-z]+/), otherwise(choice(
          sequence(routed(), next, literal(';')),
          sequence(routed(), literal('-'), regex(/[a-z]+/), literal(';')),
        ))),
      })) as Record<string, Comb>
      const prog = encodeTable(g)
      expect([...reachableIps(prog)].filter(ip => prog.code[ip] === OP_RGATE2), String(next._def.tag)).toHaveLength(1)
      for (const [name, entries] of readers(prog)) {
        for (const input of ['a-😀;', 'a-😁;', 'a-b;', 'a-\ud83d;', 'a-😀', 'a -😀;', 'a-😀; b-c;']) {
          expect(digestValue(run(entries.S!, input)), `${name} ${JSON.stringify(input)}`).toBe(digestValue(run(g.S!, input)))
        }
      }
    }
  })
})
