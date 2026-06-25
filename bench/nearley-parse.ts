/**
 * Shared Nearley runner for precompiled grammars (CommonJS module.exports).
 */
import { createRequire } from 'node:module'
import type nearleyTypes from 'nearley'

const require = createRequire(import.meta.url)
const nearley = require('nearley') as typeof nearleyTypes

export type NearleyCompiled = ReturnType<typeof require>

/** One-time: load compiled grammar + build Parser prototype state. */
export function buildNearleyParser(compiled: NearleyCompiled): (input: string) => unknown {
  const grammar = nearley.Grammar.fromCompiled(compiled)
  return (input: string) => {
    const parser = new nearley.Parser(grammar)
    parser.feed(input.trim())
    if (parser.results.length !== 1) {
      throw new Error(`nearley: expected 1 result, got ${parser.results.length}`)
    }
    return parser.results[0]
  }
}

/** Init cost: construct a Parser from the compiled grammar module. */
export function createNearleyParser(compiled: NearleyCompiled): InstanceType<typeof nearley.Parser> {
  return new nearley.Parser(nearley.Grammar.fromCompiled(compiled))
}
