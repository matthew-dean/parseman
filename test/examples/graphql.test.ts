import { describe, expect, it } from 'vitest'
import { parseGraphQL } from '../../examples/graphql/parser.ts'

describe('GraphQL parser', () => {
  it('rejects non-trivia after a complete document', () => {
    expect(() => parseGraphQL('{ viewer } trailing')).toThrow()
  })

  it('continues to accept trailing GraphQL trivia', () => {
    expect(parseGraphQL('{ viewer } # trailing comment')).toHaveLength(1)
  })
})
