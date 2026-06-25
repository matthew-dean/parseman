/**
 * Nearley JSON — upstream grammar: kach/nearley/examples/json.ne
 */
import { createRequire } from 'node:module'
import { buildNearleyParser, createNearleyParser } from './nearley-parse.ts'

const require = createRequire(import.meta.url)
const compiled = require('./json-nearley.js')

export function buildNearleyJSON(): (input: string) => unknown {
  return buildNearleyParser(compiled)
}

export function initNearleyJSON(): ReturnType<typeof createNearleyParser> {
  return createNearleyParser(compiled)
}
