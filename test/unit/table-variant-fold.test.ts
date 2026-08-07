import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeTable, type TableSettings } from '../../src/table/encode.ts'
import { emitFoldedModule } from '../../src/table/emit.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableVariants, variantNames } from '../../src/table/fold.ts'
import { foldPrograms, unfoldVariant, type TableProgram } from '../../src/table/program.ts'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/compiler/linker.ts'
import { baseNodes } from '../../bench/table-grammars.ts'
import { many, node, regex, rules } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'

/**
 * THE VARIANT FOLD (G4): one input grammar, ONE compiled output.
 *
 * The four `trackLines` x `hostMode` artifacts a dialect ships were four
 * near-copies of one table. Measured on jess's four real grammars they differ in
 * `code` and in two scalars and in nothing else, so a variant is a list of words
 * to overwrite, not another table.
 *
 * Every assertion here is against a table built the OLD way — `encodeTable` per
 * settings pair, exactly what shipped — because the only interesting question is
 * whether the folded artifact is the same parser. Bytes saved by a fold that
 * changes a tree are not a saving.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = pathToFileURL(path.resolve(DIR, '../../src/table/fold.ts')).href

const PAIRS: Record<string, TableSettings> = {
  'ast': {},
  'ast-lines': { trackLines: true },
  'cst': { hostMode: 'cst' },
  'cst-lines': { hostMode: 'cst', trackLines: true },
}

/**
 * The parse facts a consumer can observe, as one comparable string.
 *
 * A `cst` variant REQUIRES a positioned-CST build host — `run()` refuses one
 * without it — so the host is chosen from the variant, which is the only thing
 * about these calls that may differ between the folded and unfolded sides.
 */
function outcome(rule: unknown, input: string, variant = 'ast'): string {
  const opts = variant.startsWith('cst') ? { build: cstBuildHost } : {}
  const r = run(rule as never, input, opts as never)
  return JSON.stringify({
    ok: r.ok, value: r.value, span: r.span, expected: r.expected, unconsumedFrom: r.unconsumedFrom,
  })
}

/**
 * A grammar whose reducer RETURNS the span it was handed, so `trackLines` is
 * observable in the PARSE OUTPUT and not only in the table. Without it the
 * "variants stay apart" assertion passes vacuously on any two variants.
 */
const spanProbe = rules<Record<string, Combinator<unknown>>>(g => ({
  W: node('W', regex(/[^\s()]+/), (_c, _f, span) => span),
  Doc: node('Doc', many(g.W!), c => ({ spans: c })),
})) as unknown as Record<string, Combinator<unknown>>

/** Encode one grammar under every settings pair — the four shipped tables. */
function encodeAll(map: Record<string, Combinator<unknown>>): Record<string, TableProgram> {
  const out: Record<string, TableProgram> = {}
  for (const name of Object.keys(PAIRS)) out[name] = encodeTable(map, PAIRS[name]!)
  return out
}

const INPUTS = ['abc', '(a,b,12)', '(a,1)zz(b)7', '', '(a,b', '(a,)', '###', '12', 'ab\ncd']

describe('table variant fold — one base table plus per-variant row edits', () => {
  it('unfolds to programs word-identical to the separately encoded tables', () => {
    const progs = encodeAll(baseNodes)
    const folded = foldPrograms(progs, 'ast')
    expect(variantNames(folded).sort()).toEqual(Object.keys(PAIRS).sort())
    for (const name of Object.keys(PAIRS)) {
      const direct = progs[name]!
      const unfolded = unfoldVariant(folded, name)
      expect([...unfolded.code], `${name} code stream`).toEqual([...direct.code])
      expect(unfolded.lines ?? 0, `${name} lines`).toBe(direct.lines ?? 0)
      expect(unfolded.hostMode, `${name} hostMode`).toBe(direct.hostMode)
      // Everything else is the base's object, shared rather than copied.
      expect(unfolded.k).toBe(folded.base.k)
      expect(unfolded.fns).toBe(folded.base.fns)
      expect(unfolded.cc).toBe(folded.base.cc)
      expect(unfolded.disp).toBe(folded.base.disp)
      expect(unfolded.rules).toBe(folded.base.rules)
    }
  })

  it('parses identically to the separately encoded table, on every variant', () => {
    const progs = encodeAll(baseNodes)
    const folded = foldPrograms(progs, 'ast')
    for (const name of Object.keys(PAIRS)) {
      const direct = execRules(progs[name]!)
      const viaFold = tableVariants(folded, name)
      expect(Object.keys(viaFold).sort()).toEqual(Object.keys(direct).sort())
      for (const input of INPUTS) {
        expect(outcome(viaFold.Doc, input, name), `${name} on ${JSON.stringify(input)}`)
          .toBe(outcome(direct.Doc, input, name))
      }
    }
  })

  it('keeps the variants apart: a line-tracking variant reports lines, its base does not', () => {
    // The fold is only worth anything if the variants still DIFFER. Two variants
    // that parse alike everywhere would make every assertion above vacuous.
    const progs = encodeAll(spanProbe)
    const folded = foldPrograms(progs, 'ast')
    const plain = tableVariants(folded, 'ast')
    const lines = tableVariants(folded, 'ast-lines')
    // The span a reducer is handed carries line/column ONLY under trackLines.
    expect(outcome(plain.Doc, 'ab\ncd')).not.toBe(outcome(lines.Doc, 'ab\ncd'))
    // ...and each still matches the table it replaces.
    expect(outcome(lines.Doc, 'ab\ncd')).toBe(outcome(execRules(progs['ast-lines']!).Doc, 'ab\ncd'))
  })

  it('selecting the same variant twice is one program and one resolved table', () => {
    const folded = foldPrograms(encodeAll(baseNodes), 'ast')
    expect(unfoldVariant(folded, 'cst')).toBe(unfoldVariant(folded, 'cst'))
  })

  it('refuses a variant it does not carry, naming the ones it does', () => {
    const folded = foldPrograms(encodeAll(baseNodes), 'ast')
    expect(() => unfoldVariant(folded, 'nope')).toThrow(/no variant "nope".*"ast"/s)
  })

  it('refuses to fold tables of different length rather than emit a wrong one', () => {
    const a = encodeTable(baseNodes)
    const b = encodeTable(spanProbe)
    expect(() => foldPrograms({ a, b }, 'a')).toThrow(/code words.*cannot\s+resize/s)
  })

  it('refuses to fold when a SHARED field differs', () => {
    const progs = encodeAll(baseNodes)
    // A const pool that is not the base's is the shape the fold cannot ship
    // once. Refusing names the field; accepting would give every variant the
    // base's pool and change what half of them match.
    const tampered: TableProgram = { ...progs['cst']!, k: [...progs['cst']!.k, 'extra'] }
    expect(() => foldPrograms({ 'ast': progs['ast']!, 'cst': tampered }, 'ast')).toThrow(/differs from base .* in "k"/s)
  })

  it('refuses reducer pools that merely LOOK alike', () => {
    const progs = encodeAll(baseNodes)
    // Same source text, different closure. Sharing one pool between these is
    // exactly the silent-wrong-tree case the identity check exists to stop.
    const tampered: TableProgram = { ...progs['cst']!, fns: progs['cst']!.fns.map(f => (typeof f === 'function' ? (...a: unknown[]) => (f as (...x: unknown[]) => unknown)(...a) : f)) }
    expect(() => foldPrograms({ 'ast': progs['ast']!, 'cst': tampered }, 'ast')).toThrow(/BY IDENTITY/s)
  })

  it('emits ONE module whose four exports each parse like their own table', async () => {
    const progs = encodeAll(baseNodes)
    const folded = foldPrograms(progs, 'ast')
    const src = emitFoldedModule(folded, {
      runtime: RUNTIME,
      fnSources: folded.base.fns.map(f => String(f)),
      names: { 'ast': 'gAst', 'ast-lines': 'gAstLines', 'cst': 'gCst', 'cst-lines': 'gCstLines' },
    })
    // The table is printed ONCE. Four exports, one `b:{`.
    expect(src.split('b:{').length - 1).toBe(1)
    expect(src.split('export const').length - 1).toBe(4)

    const dir = mkdtempSync(path.join(tmpdir(), 'pm-table-fold-'))
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const file = path.join(dir, 'grammar.ts')
    writeFileSync(file, src)
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as Record<string, Record<string, unknown>>

    const byExport: Record<string, string> = {
      'ast': 'gAst', 'ast-lines': 'gAstLines', 'cst': 'gCst', 'cst-lines': 'gCstLines',
    }
    for (const name of Object.keys(PAIRS)) {
      const direct = execRules(progs[name]!)
      const emitted = mod[byExport[name]!]!
      for (const input of INPUTS) {
        expect(outcome(emitted.Doc, input, name), `emitted ${name} on ${JSON.stringify(input)}`)
          .toBe(outcome(direct.Doc, input, name))
      }
    }
  })
})
