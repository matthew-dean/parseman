/**
 * Jison JSON — upstream grammar: zaach/jison/examples/json.js (ECMA-262)
 * Precompiled: bench/json-jison.js (node bench/compile-jison.mjs)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const jsonJison = require('./json-jison.js') as {
  parser: { parse: (input: string) => unknown }
  Parser: new () => { parse: (input: string) => unknown }
}

export function buildJisonJSON(): (input: string) => unknown {
  return (input: string) => new jsonJison.Parser().parse(input.trim())
}

/** One-time: fresh parser instance from precompiled tables. */
export function initJisonJSON(): InstanceType<typeof jsonJison.Parser> {
  return new jsonJison.Parser()
}
