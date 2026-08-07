/**
 * Benchmark fairness guard: every parser in a bench language suite must build
 * the SAME value, so `bench/run.ts` compares equivalent work rather than
 * penalising one library for producing a heavier structure (e.g. a CST that a
 * second pass then traverses). This grew out of Chevrotain PR #2189 — the
 * Chevrotain benches used to emit a CST while the others built plain values. If
 * you add a bench parser or change a grammar's output shape, this keeps them
 * honest.
 *
 * `toEqual` (not `toStrictEqual`) is deliberate: some parsers build
 * null-prototype objects (`Object.create(null)`, an anti-prototype-pollution
 * choice) — semantically identical values, so they must not fail parity.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '../../src/index.ts'
import { graphqlDoc, parseGraphQL } from '../../examples/graphql/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'
import { compiledCSV, parseCSV } from '../../examples/csv/parser.ts'
import { buildParsimmonGraphQL } from '../../bench/parsimmon-graphql.ts'
import { buildPeggyGraphQL } from '../../bench/peggy-graphql.ts'
import { buildNearleyGraphQL } from '../../bench/nearley-graphql.ts'
import { buildJisonGraphQL } from '../../bench/jison-graphql.ts'
import { buildParsimmonCSV } from '../../bench/parsimmon-csv.ts'
import { buildPeggyCSV } from '../../bench/peggy-csv.ts'
import { buildNearleyCSV } from '../../bench/nearley-csv.ts'
import { buildChevrotainCSV } from '../../bench/chevrotain-csv.ts'
import { buildParsimmonJSON } from '../../bench/parsimmon-json.ts'
import { buildPeggyJSON } from '../../bench/peggy-json.ts'
import { buildNearleyJSON } from '../../bench/nearley-json.ts'
import { buildJisonJSON } from '../../bench/jison-json.ts'
import {
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
  SMALL_CSV, LARGE_CSV,
  } from '../../bench/fixtures.ts'

/**
 * Chevrotain 12 calls `Object.groupBy` (Node 21+) from `performSelfAnalysis`, which
 * runs at MODULE scope — so on Node 20, importing the bench at all throws
 * `TypeError: Object.groupBy is not a function` and takes the whole FILE down, not
 * just its own cases. A `describe.skipIf` cannot help with that; the import has to
 * be conditional, hence the top-level await.
 *
 * Node 20 is inside this package's supported range (`^20.19.0 || >=22.12.0`). The
 * other four bench parsers still run there — only the Chevrotain comparison is
 * dropped, and it compares a THIRD-PARTY library's output shape, so nothing about
 * Parseman goes unverified on that line.
 */
const HAS_GROUP_BY = typeof (Object as { groupBy?: unknown }).groupBy === 'function'
const chevrotain = HAS_GROUP_BY
  ? {
      gql: (await import('../../bench/chevrotain-graphql.ts')).buildChevrotainGraphQL(),
      json: (await import('../../bench/chevrotain-json.ts')).buildChevrotainJSON(),
    }
  : null

function generatedKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return []
  const out: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`
    if (/^_opt\d+$/.test(key)) out.push(childPath)
    out.push(...generatedKeys(child, childPath))
  }
  return out
}

describe('Parseman GraphQL example compiler parity', () => {
  it('preserves authored AST keys for optional aliases', () => {
    const input = `query Dashboard0($id: ID!) {
  viewer {
    id
  }
}`
    const interpreted = graphqlDoc.parse(input)
    const compiled = compile(graphqlDoc).parse(input)

    expect(compiled).toEqual(interpreted)
    expect(compiled.ok && compiled.value[0]!.selectionSet[0]).toMatchObject({
      alias: null,
      name: 'viewer',
    })
    expect(compiled.ok && generatedKeys(compiled.value)).toEqual([])
  })
})

describe('GraphQL bench parsers build the same AST as Parséman', () => {
  const fixtures = { small: SMALL_GQL, medium: MEDIUM_GQL, large: LARGE_GQL }
  const parsers = {
    Peggy: buildPeggyGraphQL(),
    Parsimmon: buildParsimmonGraphQL(),
    Nearley: buildNearleyGraphQL(),
    Jison: buildJisonGraphQL(),
    ...(chevrotain ? { Chevrotain: chevrotain.gql } : {}),
  }
  for (const [fxName, input] of Object.entries(fixtures)) {
    const reference = parseGraphQL(input)
    for (const [pName, parse] of Object.entries(parsers)) {
      it(`${pName} — ${fxName}`, () => expect(parse(input)).toEqual(reference))
    }
  }
})

describe('JSON bench parsers build the same value as JSON.parse', () => {
  const fixtures = { small: SMALL_JSON, medium: MEDIUM_JSON, large: LARGE_JSON }
  const parsers = {
    Parséman: (s: string) => { const r = jsonDoc.parse(s); return r.ok ? r.value : undefined },
    Peggy: buildPeggyJSON(),
    Parsimmon: buildParsimmonJSON(),
    Nearley: buildNearleyJSON(),
    Jison: buildJisonJSON(),
    ...(chevrotain ? { Chevrotain: chevrotain.json } : {}),
  }
  for (const [fxName, input] of Object.entries(fixtures)) {
    const reference = JSON.parse(input)
    for (const [pName, parse] of Object.entries(parsers)) {
      it(`${pName} — ${fxName}`, () => expect(parse(input)).toEqual(reference))
    }
  }
})

describe('CSV bench parsers consume the whole chart input and build the same rows', () => {
  const fixtures = { small: SMALL_CSV, large: LARGE_CSV }
  const parsers = {
    Peggy: buildPeggyCSV(),
    Parsimmon: buildParsimmonCSV(),
    Nearley: buildNearleyCSV(),
    Chevrotain: buildChevrotainCSV(),
  }
  for (const [fxName, input] of Object.entries(fixtures)) {
    it(`Parséman — ${fxName} consumes every byte`, () => {
      const result = compiledCSV.parse(input)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.span.end).toBe(input.length)
      expect(result.value).toEqual(parseCSV(input))
    })
    for (const [pName, parse] of Object.entries(parsers)) {
      it(`${pName} — ${fxName}`, () => expect(parse(input)).toEqual(parseCSV(input)))
    }
  }
})
