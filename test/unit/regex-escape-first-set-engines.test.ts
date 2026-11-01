/**
 * ESCAPES THAT ARE NOT THEIR LETTER, through every engine.
 *
 * A regex's first set gates trivia skips, choice dispatch and optional terms. It
 * was read wrongly for escapes whose meaning is not the escaped character, and
 * for non-ASCII letters under `/i`:
 * - legacy octal `\012`;
 * - control `\cJ`;
 * - property `\p{…}`;
 * - code point `\u{…}`;
 * - `/é/i`, which also matches `É`.
 *
 * Each engine then refused input the regex matches. Every case here runs through
 * the interpreter, `execRules`, the closure engine and the emitted assembly:
 * - the three table engines must agree on the whole `RunResult`;
 * - the interpreter must agree on the value, the span and where unconsumed input
 *   begins, since its expected sets are narrower by design;
 * - every case parses its input whole.
 */
import { describe, expect, it } from 'vitest'
import { choice, many, optional, regex, rules, sequence, trivia } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { run, type RunResult } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import type { Combinator } from '../../src/types.ts'

type Grammar = Record<string, Combinator<unknown>>
type Case = { readonly name: string; readonly grammar: Grammar; readonly inputs: readonly string[] }

const words = (t: Combinator<unknown>): Grammar =>
  rules<Grammar>({ trivia: t }, g => ({ Doc: many(g.Word!), Word: regex(/[a-z]+/) }))
// Legacy octal escapes are spelled through `RegExp`, since TypeScript refuses them
// in a regex literal.
const one = (p: Combinator<unknown>): Grammar => rules<Grammar>(() => ({ Doc: p }))

const CASES: Case[] = [
  { name: 'trivia \\p{White_Space} (u)', grammar: words(trivia(regex(/\p{White_Space}+/u))), inputs: ['a b', 'a b'] },
  { name: 'trivia legacy octal \\012', grammar: words(trivia(regex(new RegExp('(?: |\\012)+')))), inputs: ['a\nb', 'a b'] },
  { name: 'trivia control \\cJ', grammar: words(trivia(regex(/(?: |\cJ)+/))), inputs: ['a\nb'] },
  { name: 'trivia code point \\u{20} (u)', grammar: words(trivia(regex(/\u{20}+/u))), inputs: ['a b'] },
  { name: 'trivia class [\\012]', grammar: words(trivia(regex(new RegExp('[ \\012]+')))), inputs: ['a\nb'] },
  { name: 'trivia /é/i', grammar: words(trivia(regex(/(?:[ \n]|é)+/i))), inputs: ['aÉb', 'aéb'] },
  { name: 'trivia /σ/i', grammar: words(trivia(regex(/(?:[ \n]|σ)+/i))), inputs: ['aΣb', 'aςb', 'aσb'] },
  { name: 'trivia /[à-ÿ]/i', grammar: words(trivia(regex(/(?:[ \n]|[à-ÿ])+/i))), inputs: ['aÀb', 'aÿb'] },
  // A set holding every code unit from 128 up keeps its first set under `/i`.
  { name: 'choice arm /[\u0080-\uffff]/i', grammar: one(choice(regex(/[\u0080-\uffff]x/i), regex(/[a-z]+/))), inputs: ['Éx', 'ab'] },
  { name: 'choice arm \\cJ', grammar: one(choice(regex(/\cJa/), regex(/[a-z]+/))), inputs: ['\na', 'a'] },
  { name: 'choice arm \\012', grammar: one(choice(regex(new RegExp('\\012a')), regex(/[a-z]+/))), inputs: ['\na'] },
  { name: 'choice arm \\p{Lu} (u)', grammar: one(choice(regex(/\p{Lu}x/u), regex(/[a-z]+/))), inputs: ['Ax'] },
  { name: 'choice arm \\u{41} (u)', grammar: one(choice(regex(/\u{41}x/u), regex(/[a-z]+/))), inputs: ['Ax'] },
  { name: 'choice arm /éx/i', grammar: one(choice(regex(/éx/i), regex(/[a-z]+/))), inputs: ['Éx'] },
  { name: 'optional \\cJ', grammar: one(sequence(optional(regex(/\cJ/)), regex(/[a-z]+/))), inputs: ['\na', 'a'] },
]

const shape = (r: RunResult): unknown => [r.ok, r.ok ? r.value : null, r.span, r.unconsumedFrom]

describe('escapes and /i letters are read the same by every engine', () => {
  for (const { name, grammar, inputs } of CASES) {
    it(name, () => {
      const prog = encodeTable(grammar)
      const reference = execRules(prog).Doc!
      const closure = tableRules({ ...prog, asm: [] }).Doc!
      const { asm: _none, ...noAsm } = prog
      const emitted = tableRules(noAsm).Doc!
      for (const input of inputs) {
        const want = run(reference, input)
        expect(want.ok && want.unconsumedFrom === null, `${JSON.stringify(input)} parses whole`).toBe(true)
        expect(shape(run(grammar.Doc!, input)), `${JSON.stringify(input)}: interpreter`).toEqual(shape(want))
        expect(digestValue(run(closure, input)), `${JSON.stringify(input)}: closure`).toBe(digestValue(want))
        expect(digestValue(run(emitted, input)), `${JSON.stringify(input)}: emitted`).toBe(digestValue(want))
      }
    })
  }
})
