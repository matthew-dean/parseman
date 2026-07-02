/**
 * Lezer JSON parser for benchmark comparison.
 *
 * Lezer (the parser behind CodeMirror 6) is a pure-JS incremental LR parser. Unlike
 * the value-building parsers in the JSON group, it produces a compact *syntax tree*
 * (a buffer-backed `Tree`), not JS values — so it belongs in the tree-building group
 * alongside Parséman CST and Chevrotain CST.
 */
import { parser as jsonParser } from '@lezer/json'
import type { Tree } from '@lezer/common'

/** Parse only — returns the root Tree handle (buffer-backed, not walked). */
export function buildLezerJSONParseOnly(): (input: string) => Tree {
  return (input: string) => jsonParser.parse(input)
}

/** Parse and walk every node so the tree is fully visited. */
export function buildLezerJSON(): (input: string) => number {
  const parseOnly = buildLezerJSONParseOnly()
  return (input: string): number => {
    const tree = parseOnly(input)
    let count = 0
    const cursor = tree.cursor()
    do {
      count++
    } while (cursor.next())
    return count
  }
}
