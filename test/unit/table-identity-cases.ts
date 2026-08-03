/** Shared inputs for the table-identity sweep. Kept beside the test, not in bench/. */
import { LARGE_JSON, MEDIUM_JSON, SMALL_JSON } from '../../bench/fixtures.ts'

export const JSON_CASES = [
  { name: 'small', input: SMALL_JSON },
  { name: 'medium', input: MEDIUM_JSON },
  { name: 'large', input: LARGE_JSON },
  { name: 'scalars', input: '[1, -2.5, 1e10, true, false, null, "a\\nb", "\\u0041"]' },
  { name: 'nested', input: '{"a":{"b":[{"c":[[[]]]}]},"d":[]}' },
  { name: 'empty-obj', input: '{}' },
  { name: 'empty-arr', input: '[]' },
  { name: 'ws', input: '  {  "a" :  [ 1 , 2 ]  ,  "b" : null  }  ' },
  // Failure paths matter as much as success: a table that agrees on accepted
  // input and diverges on rejected input is still a divergence.
  { name: 'bad-trailing-comma', input: '[1,2,]' },
  { name: 'bad-unclosed', input: '{"a":' },
  { name: 'bad-bare', input: 'nope' },
]

export const ladderCases = (n: number): Array<{ name: string; input: string }> => [
  { name: 'all', input: Array.from({ length: n }, (_, i) => `r${i}`).join(' ') },
  { name: 'first', input: 'r0' },
  { name: 'last', input: `r${n - 1}` },
  { name: 'none', input: '' },
]

export const BASE_CASES = [
  { name: 'one', input: 'a' },
  { name: 'many', input: 'a b c' },
  { name: 'empty', input: '' },
]

export const LESS_CASES = [
  { name: 'rule', input: 'a { color: red }' },
  { name: 'nested', input: 'a { b { color: red } }' },
  { name: 'at-rule', input: '@media (min-width: 100px) { a { color: red } }' },
  { name: 'decl-list', input: 'a { color: red; background: blue; margin: 0 }' },
  { name: 'comment', input: 'a { /* c */ color: red }' },
]
