/**
 * Nearley CSV — upstream grammar: kach/nearley/examples/csv.ne
 */
import { createRequire } from 'node:module'
import { buildNearleyParser, createNearleyParser } from './nearley-parse.ts'

const require = createRequire(import.meta.url)
const compiled = require('./csv-nearley.js')

export function buildNearleyCSV(): (input: string) => unknown {
  return buildNearleyParser(compiled)
}

export function initNearleyCSV(): ReturnType<typeof createNearleyParser> {
  return createNearleyParser(compiled)
}
