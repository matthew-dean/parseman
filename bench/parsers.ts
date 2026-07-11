/**
 * Pre-built parsers shared by bench/run.ts and chart SVG collection.
 * Built once at import time so warm-parse timings are not polluted by setup.
 */
import { parseJSON, jsonDoc } from '../examples/json/parser.ts'
import { buildParsermanCSTJSONNoTriv, buildParsermanCSTJSONCompiled } from './parseman-cst-json.ts'
import { parseCSV, compiledCSV, csvParser } from '../examples/csv/parser.ts'
import { parseGraphQL, graphqlDoc } from '../examples/graphql/parser.ts'
import { compile } from '../src/index.ts'
import { buildChevrotainJSON } from './chevrotain-json.ts'
import { buildChevrotainCSTJSON } from './chevrotain-cst-json.ts'
import { buildChevrotainCSV } from './chevrotain-csv.ts'
import { buildChevrotainGraphQL } from './chevrotain-graphql.ts'
import { buildParsimmonJSON } from './parsimmon-json.ts'
import { buildParsimmonCSV } from './parsimmon-csv.ts'
import { buildParsimmonGraphQL } from './parsimmon-graphql.ts'
import { buildPeggyJSON } from './peggy-json.ts'
import { buildPeggyCSV } from './peggy-csv.ts'
import { buildPeggyGraphQL } from './peggy-graphql.ts'
import { buildNearleyJSON } from './nearley-json.ts'
import { buildNearleyCSV } from './nearley-csv.ts'
import { buildNearleyGraphQL } from './nearley-graphql.ts'
import { buildJisonJSON } from './jison-json.ts'
import { buildJisonGraphQL } from './jison-graphql.ts'
import { buildLezerJSON, buildLezerJSONParseOnly } from './lezer-json.ts'

export const parsermanCSTCompiled   = buildParsermanCSTJSONCompiled()
export const parsermanCSTJSONNoTriv = buildParsermanCSTJSONNoTriv()
export const compiledJSON           = compile(jsonDoc)
export const compiledGraphQL        = compile(graphqlDoc)
export const chevrotainJSON         = buildChevrotainJSON()
export const chevrotainCSTJSON      = buildChevrotainCSTJSON()
export const chevrotainCSV          = buildChevrotainCSV()
export const chevrotainGQL          = buildChevrotainGraphQL()
export const parsimmonJSON          = buildParsimmonJSON()
export const parsimmonCSV           = buildParsimmonCSV()
export const parsimmonGQL           = buildParsimmonGraphQL()
export const peggyJSON              = buildPeggyJSON()
export const peggyCSV               = buildPeggyCSV()
export const peggyGQL               = buildPeggyGraphQL()
export const nearleyJSON            = buildNearleyJSON()
export const nearleyCSV             = buildNearleyCSV()
export const nearleyGQL             = buildNearleyGraphQL()
export const jisonJSON              = buildJisonJSON()
export const jisonGQL               = buildJisonGraphQL()
export const lezerJSON              = buildLezerJSON()
export const lezerJSONParse         = buildLezerJSONParseOnly()

export {
  parseJSON, parseCSV, parseGraphQL, csvParser, jsonDoc, graphqlDoc,
  compiledCSV,
}
