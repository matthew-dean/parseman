/**
 * Nearley GraphQL — grammar ported from bench/graphql.pegjs (bench/vendor/nearley/graphql.ne)
 */
import { createRequire } from 'node:module'
import { buildNearleyParser, createNearleyParser } from './nearley-parse.ts'

const require = createRequire(import.meta.url)
const compiled = require('./graphql-nearley.cjs')

export function buildNearleyGraphQL(): (input: string) => unknown {
  return buildNearleyParser(compiled)
}

export function initNearleyGraphQL(): ReturnType<typeof createNearleyParser> {
  return createNearleyParser(compiled)
}
