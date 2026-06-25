/**
 * Jison GraphQL — grammar ported from bench/graphql.pegjs (bench/vendor/jison/graphql-grammar.cjs)
 * Precompiled: bench/graphql-jison.cjs (node bench/compile-jison.mjs)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const graphqlJison = require('./graphql-jison.cjs') as {
  parser: { parse: (input: string) => unknown }
  Parser: new () => { parse: (input: string) => unknown }
}

export function buildJisonGraphQL(): (input: string) => unknown {
  return (input: string) => new graphqlJison.Parser().parse(input)
}

/** One-time: fresh parser instance from precompiled tables. */
export function initJisonGraphQL(): InstanceType<typeof graphqlJison.Parser> {
  return new graphqlJison.Parser()
}
