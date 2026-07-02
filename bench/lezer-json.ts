/**
 * Lezer JSON parser for benchmark comparison.
 *
 * Lezer (the parser behind CodeMirror 6) is a pure-JS incremental LR parser. Unlike
 * the value-building parsers in the JSON group, it produces a compact *syntax tree*
 * (a buffer-backed `Tree`), not JS values — so it belongs in the tree-building group
 * alongside Parséman CST and Chevrotain CST, where "produce a parse tree" is the
 * shared unit of work.
 *
 * We walk the whole tree with a cursor after parsing so the comparison measures a fully
 * materialized traversal, not just the (lazily-consumed) root handle.
 */
import { parser as jsonParser } from '@lezer/json'
import type { Tree } from '@lezer/common'

/** Parse to a Lezer Tree and walk every node so the tree is fully visited. */
export function buildLezerJSON(): (input: string) => number {
  return (input: string): number => {
    const tree: Tree = jsonParser.parse(input)
    let count = 0
    const cursor = tree.cursor()
    do {
      count++
    } while (cursor.next())
    return count
  }
}
