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
import { parseGraphQL } from '../../examples/graphql/parser.ts'
import { jsonDoc } from '../../examples/json/parser.ts'
import { buildChevrotainGraphQL } from '../../bench/chevrotain-graphql.ts'
import { buildParsimmonGraphQL } from '../../bench/parsimmon-graphql.ts'
import { buildPeggyGraphQL } from '../../bench/peggy-graphql.ts'
import { buildNearleyGraphQL } from '../../bench/nearley-graphql.ts'
import { buildJisonGraphQL } from '../../bench/jison-graphql.ts'
import { buildChevrotainJSON } from '../../bench/chevrotain-json.ts'
import { buildParsimmonJSON } from '../../bench/parsimmon-json.ts'
import { buildPeggyJSON } from '../../bench/peggy-json.ts'
import { buildNearleyJSON } from '../../bench/nearley-json.ts'
import { buildJisonJSON } from '../../bench/jison-json.ts'
import {
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
} from '../../bench/fixtures.ts'

describe('GraphQL bench parsers build the same AST as Parséman', () => {
  const fixtures = { small: SMALL_GQL, medium: MEDIUM_GQL, large: LARGE_GQL }
  const parsers = {
    Peggy: buildPeggyGraphQL(),
    Parsimmon: buildParsimmonGraphQL(),
    Nearley: buildNearleyGraphQL(),
    Jison: buildJisonGraphQL(),
    Chevrotain: buildChevrotainGraphQL(),
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
    Chevrotain: buildChevrotainJSON(),
  }
  for (const [fxName, input] of Object.entries(fixtures)) {
    const reference = JSON.parse(input)
    for (const [pName, parse] of Object.entries(parsers)) {
      it(`${pName} — ${fxName}`, () => expect(parse(input)).toEqual(reference))
    }
  }
})
