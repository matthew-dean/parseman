import { describe, expect, it } from 'vitest'
import { graphqlDoc } from '../../examples/graphql/parser.ts'
import { scalarRootOf } from '../../src/combinators/scalar.ts'
import { createParseContext } from '../../src/parse-context.ts'

const DOCUMENTS = [
  '{ user { id name } }',
  'query GetUser($id: ID!) { user(id: $id) { id name } }',
  'mutation Set($n: Int = 3) { set(value: $n enabled: true missing: null) }',
  'fragment UserFields on User { id name } query Q { user { ...UserFields } }',
  '{ field(values: [1 -2 3.5 "x"] input: {enabled: false mode: CUSTOM}) }',
] as const

describe('GraphQL strict scalar-root admission', () => {
  it('admits the complete recursive GraphQL document root', () => {
    expect(scalarRootOf(graphqlDoc)).toBeTypeOf('function')
  })

  it('preserves the general interpreter values and spans', () => {
    for (const input of DOCUMENTS) {
      expect(graphqlDoc.parse(input), input)
        .toEqual(graphqlDoc.parse(input, 0, createParseContext()))
    }
  })
})
