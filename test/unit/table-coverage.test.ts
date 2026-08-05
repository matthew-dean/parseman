import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileTable } from '../../src/table/compile.ts'
import { compileRuleMapTable } from '../../src/table/compile-rule-map.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { opHistogram } from '../../src/table/inspect.ts'
import { buildGrammarPlan } from '../../src/compiler/grammar-coverage-ids.ts'
import {
  compiledGrammarCoverageDefinitions,
  createGrammarCoverageCollector,
  createGrammarInstrumentationContext,
  GRAMMAR_COVERAGE_DEFINITIONS,
  type GrammarCoverageDefinition,
} from '../../src/coverage.ts'
import { jsonRules, JSON_FN_SOURCES, dispatchNodes } from '../../bench/table-grammars.ts'
import { choice, label, literal, rules, sequence, transform } from '../../src/index.ts'
import type { Combinator } from '../../src/types.ts'
import type { ParseResult } from '../../src/types.ts'

/**
 * GRAMMAR-COVERAGE COUNTERS FOR THE TABLE LOWERING.
 *
 * `compileTable` and `compileRuleMapTable` used to THROW on `{ coverage: true }`,
 * which was the honest answer while there was nothing to count — but it made a
 * coverage-enabled macro build impossible under the table. These are the counters.
 *
 * COUNTERS ONLY, per the owner ruling in `notes/RELEASE-0.48-TARGET.md` §1:
 * `_grammarTrace`'s six phases are ~40 fine-grained emission sites in
 * `codegen.ts` and are 0.48 work. Nothing here asserts a trace event, and the
 * last case in this file pins that the gap is a KNOWN one rather than a silent
 * one — a consumer that installs a sink gets no events, not wrong events.
 *
 * WHAT "WORKS" MEANS HERE, and why every test is written the way it is:
 *
 *   IDS MUST LINE UP WITH THE SOURCE LOWERING. An id scheme that is internally
 *   consistent and matches nothing is not a fix — a consumer switching lowerings
 *   would silently compare two different denominators. So the definition sets are
 *   asserted EQUAL to `compile()`'s, not merely well-formed.
 *
 *   HITS MUST DISCRIMINATE. "The throw is gone" and "a parser came back" are both
 *   satisfied by a build that counts nothing, which is the exact silent-nothing
 *   failure this project keeps finding (`parseWithErrors` returning an empty
 *   `errors` array was one). Every hit assertion below therefore names both a
 *   construct that MUST be hit and one that must NOT be, on the same grammar.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const TABLE = pathToFileURL(path.resolve(DIR, '../../src/table/index.ts')).href

type Rule = (input: string, pos: number, ctx: unknown) => ParseResult<unknown>

const jsonEntries = Object.entries(jsonRules as unknown as Record<string, Combinator<unknown>>)

/**
 * A coverage-encoded rule map, assembled, WITHOUT going through the printer.
 *
 * `compileRuleMapTable` answers `null` for a grammar whose reducers reached it as
 * live closures with no source — an all-or-nothing PRINTING gate, unrelated to
 * coverage, and every grammar built inside a test is in that position. The
 * counters are the same rows either way, so the cases that only need to observe
 * hits use this and the cases that are about the artifact use the compiler.
 */
function covRules(g: Record<string, Combinator<unknown>>): {
  rules: Record<string, Rule>
  definitions: readonly GrammarCoverageDefinition[]
} {
  const entries = Object.entries(g)
  const plan = buildGrammarPlan(
    entries.map(([, r]) => r),
    Object.fromEntries(entries.filter(([, r]) => r._def.tag !== 'lazy')),
  )
  const prog = encodeTable(g, { coverage: plan })
  return { rules: assembledRules(prog) as unknown as Record<string, Rule>, definitions: plan.definitions }
}

/** Parse once with a collector attached and hand back the ids it recorded. */
function hits(rule: Rule, definitions: readonly GrammarCoverageDefinition[], input: string): readonly string[] {
  const collector = createGrammarCoverageCollector(definitions)
  const ctx = createGrammarInstrumentationContext({ collector })
  const r = rule(input, 0, ctx)
  expect(r.ok, `the probe input ${JSON.stringify(input)} must parse, or its hits mean nothing`).toBe(true)
  return collector.snapshot().hits
}

describe('the table lowering counts grammar coverage', () => {
  it('mints the SAME definitions as the source lowering, for a single root', () => {
    const root = (jsonRules as unknown as Record<string, Combinator<unknown>>)['Value']!
    const tabled = compileTable(root, undefined, { coverage: true })
    const sourced = compile(root, undefined, { coverage: true })
    // Not "both are non-empty" — EQUAL. The ids are the contract, and both
    // engines mint them from one `buildGrammarPlan` walk over one graph.
    expect(tabled.coverageDefinitions).toEqual(sourced.coverageDefinitions)
    expect(tabled.coverageDefinitions!.length).toBeGreaterThan(0)
  })

  it('mints the SAME definitions as the source lowering, for a rule map', () => {
    const compiled = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!
    // `compileRuleMap` cannot return a replacement for this map (its reducers
    // reach a module-level helper, so nothing can be inlined) and answers `null`.
    // Its DEFINITIONS are still `buildGrammarPlan`'s, built from the same winner
    // filter — that filter is the thing worth pinning, because picking winners
    // differently is what would slide the two engines' `rule:` sets apart.
    const winners = Object.fromEntries(jsonEntries.filter(([, r]) => r._def.tag !== 'lazy'))
    expect(compiled.coverageDefinitions)
      .toEqual(buildGrammarPlan(jsonEntries.map(([, r]) => r), winners).definitions)
    expect(compiled.coverageDefinitions!.some(d => d.kind === 'rule')).toBe(true)
    expect(compiled.coverageDefinitions!.some(d => d.kind === 'choice-arm')).toBe(true)
  })

  it('records RULE and CHOICE-ARM hits, and only the ones the input reaches', () => {
    const compiled = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!
    const definitions = compiled.coverageDefinitions!
    const value = compiled.rules['Value'] as unknown as Rule

    const onTrue = hits(value, definitions, 'true')
    const onFalse = hits(value, definitions, 'false')

    // THE DISCRIMINATION, both ways round. `true` and `false` are sibling arms of
    // one choice and separate rules, so if the counters were wired to the choice
    // rather than to its arms — or fired on every arm ENTERED rather than the arm
    // that WON — these two sets would be identical.
    expect(onTrue).toContain('rule:True')
    expect(onTrue).not.toContain('rule:False')
    expect(onFalse).toContain('rule:False')
    expect(onFalse).not.toContain('rule:True')
    expect(onTrue.filter(id => id.startsWith('choice:')))
      .not.toEqual(onFalse.filter(id => id.startsWith('choice:')))

    // A rule reached only THROUGH another rule still counts: `Pair` and `Str` are
    // never the entry, and a counter placed on the rule ENTRY rather than on the
    // rule BODY would credit `Value` alone however much of the grammar ran.
    const onObject = hits(value, definitions, '{"a":1}')
    expect(onObject).toEqual(expect.arrayContaining(['rule:Obj', 'rule:Pair', 'rule:Str', 'rule:Num']))
  })

  it('records a hit for a RECURSIVE rule reached only through its own back-edge', () => {
    // `Arr` contains `Value` contains `Arr`. The encoder patches recursion with an
    // `OP_RULE` trampoline, and the counter has to be on the offset the trampoline
    // is patched WITH — otherwise the second and deeper entries jump past it.
    const compiled = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!
    const arr = compiled.rules['Arr'] as unknown as Rule
    expect(hits(arr, compiled.coverageDefinitions!, '[[1]]')).toContain('rule:Arr')
  })

  it('records DISPATCH-ARM hits, per arm, including the fallback', () => {
    const { rules: r, definitions } = covRules(dispatchNodes as unknown as Record<string, Combinator<unknown>>)
    const doc = r['Doc']!

    // One id per ARM, not per KEY, and in resolution order: cases, then matchers,
    // then `otherwise`. A running index that consumed one id per key would slide
    // every later arm onto its neighbour's identity — which still produces hits,
    // and produces the wrong ones.
    expect(hits(doc, definitions, '@media')).toEqual(expect.arrayContaining([expect.stringContaining('when:%40media')]))
    expect(hits(doc, definitions, '@-webkit')).toEqual(expect.arrayContaining([expect.stringContaining('matcher:startsWith')]))
    expect(hits(doc, definitions, '@unknown')).toEqual(expect.arrayContaining([expect.stringContaining('otherwise')]))
    // …and each of those is the ONLY arm credited on its own input.
    expect(hits(doc, definitions, '@media')).not.toEqual(expect.arrayContaining([expect.stringContaining('otherwise')]))
    expect(hits(doc, definitions, '@unknown').filter(id => id.includes('when:'))).toEqual([])
  })

  it('records a LABEL hit on success and not on a failed labelled child', () => {
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: choice(
        sequence(literal('a'), label('tail', literal('!'))),
        transform(literal('a'), () => 'bare'),
      ) as unknown as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const { rules: r, definitions } = covRules(g)
    expect(definitions.some(d => d.kind === 'label')).toBe(true)
    const doc = r['Doc']!
    // `a!` takes the labelled arm; `a` alone fails it and falls to the second.
    expect(hits(doc, definitions, 'a!').some(id => id.startsWith('label:'))).toBe(true)
    expect(hits(doc, definitions, 'a').some(id => id.startsWith('label:'))).toBe(false)
  })

  it('costs an ordinary build NOTHING — no rows, no pool, the same bytes', () => {
    // COVERAGE IS OPT-IN AND THE DEFAULT MUST NOT MOVE. `bench/size-guard.ts`
    // ratchets emitted sizes with no headroom by design, so "the coverage table is
    // bigger" is only acceptable while the ordinary table is byte-for-byte what it
    // was. Both the emitted text and the reachable opcode histogram are compared,
    // because a row that is present and unreachable would not show in the text.
    const plain = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES })!
    const explicitlyOff = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: false })!
    const covered = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!

    expect(plain.replacement).toBe(explicitlyOff.replacement)
    expect(plain.replacement).not.toContain('cv:')
    expect(plain.prog.cov).toBeUndefined()
    expect(opHistogram(plain.prog).COV).toBeUndefined()

    expect(covered.replacement).toContain('cv:')
    expect(opHistogram(covered.prog).COV).toBeGreaterThan(0)
    expect(covered.replacement.length).toBeGreaterThan(plain.replacement.length)
  })

  it('carries the definition pool THROUGH the emitted module, and still counts', async () => {
    // The macro's artifact is TEXT. A pool that exists in memory and not in the
    // emitted table gives a loaded grammar counter rows with nothing to credit —
    // which `assemble` refuses outright rather than counting silently, so this
    // test would fail loudly either way. It is here to prove the emission, not the
    // refusal.
    const g = rules<Record<string, Combinator<unknown>>>(() => ({
      Doc: choice(
        transform(literal('x'), () => 'X'),
        transform(literal('y'), () => 'Y'),
      ) as unknown as Combinator<unknown>,
    })) as unknown as Record<string, Combinator<unknown>>
    const prog = encodeTable(g, { coverage: buildGrammarPlan([g['Doc']!], { Doc: g['Doc']! }) })
    const { emitTableModule } = await import('../../src/table/emit.ts')
    const src = emitTableModule(prog, { name: 'g', runtime: TABLE, fnSources: prog.fns.map(f => String(f)) })
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-table-cov-'))
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const file = path.join(dir, 'grammar.ts')
    writeFileSync(file, src)
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href) as { g: Record<string, unknown> }

    const definitions = prog.cov!.map(([id, kind]) => ({ id, kind })) as unknown as GrammarCoverageDefinition[]
    const loaded = mod.g['Doc'] as unknown as Rule
    const onX = hits(loaded, definitions, 'x')
    const onY = hits(loaded, definitions, 'y')
    expect(onX).not.toEqual(onY)
    expect(onX.length).toBeGreaterThan(0)
  })

  it('is DORMANT without a collector — the same graph, and no throw', () => {
    // A coverage-encoded table run by an ordinary parse must behave like an
    // ordinary table. The counter rows are resolved away at link time (the
    // assembly for `coverage: false` returns the child piece itself), so this is
    // the assertion that the option is selected at ASSEMBLY and not tested per
    // node.
    const compiled = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!
    const plain = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES })!
    const input = '{"a":[1,true,null,"s"]}'
    const covered = (compiled.rules['Value'] as unknown as Rule)(input, 0, { trackLines: false })
    const ordinary = (plain.rules['Value'] as unknown as Rule)(input, 0, { trackLines: false })
    expect(JSON.stringify(covered)).toBe(JSON.stringify(ordinary))
  })

  it('a trace sink receives NOTHING — the 0.48 gap is known, not silent', () => {
    // Stated as a test rather than left to a comment. If trace parity lands, this
    // is the assertion that has to be rewritten, which is the point of pinning it.
    const compiled = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!
    const events: unknown[] = []
    const ctx = createGrammarInstrumentationContext({
      collector: createGrammarCoverageCollector(compiled.coverageDefinitions!),
      trace: { write: e => { events.push(e) }, snapshot: () => ({ events: [], truncated: false, dropped: 0 }) },
    })
    expect((compiled.rules['Value'] as unknown as Rule)('true', 0, ctx).ok).toBe(true)
    expect(events).toEqual([])
  })

  it('satisfies `compiledGrammarCoverageDefinitions` when stamped on a grammar', () => {
    // The plugin stamps the definitions it is handed onto the emitted grammar
    // object and a consumer reads them back through this validator. The table's
    // pool has to pass it — an `[id, kind]` pair that read back with a `kind`
    // outside the union would be rejected there, one hop away from where it was
    // produced.
    const compiled = compileRuleMapTable(jsonEntries, { fnSources: JSON_FN_SOURCES, coverage: true })!
    const grammar: Record<string | symbol, unknown> = { ...compiled.rules }
    grammar[GRAMMAR_COVERAGE_DEFINITIONS] = compiled.coverageDefinitions
    expect(compiledGrammarCoverageDefinitions(grammar as Record<string, unknown>))
      .toEqual(compiled.coverageDefinitions)
  })
})
