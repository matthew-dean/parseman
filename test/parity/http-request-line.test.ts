/**
 * Parity test: the runtime interpreter must produce identical results to
 * a hand-written reference parser for the same inputs.
 *
 * Parser: HTTP/1.x request line
 *   METHOD SP request-target SP HTTP/1.x CRLF
 */
import { describe, it, expect } from 'vitest'
import { literal, sequence, choice, regex, transform, parse, compile } from '../../src/index.ts'

type RequestLine = {
  method: string
  target: string
  version: string
}

// --- parseman parser ---
const method = choice(
  literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'),
  literal('PATCH'), literal('HEAD'), literal('OPTIONS')
)
const sp = literal(' ')
const requestTarget = regex(/[^\s]+/)
const httpVersion = sequence(literal('HTTP/'), regex(/1\.[01]/))
const crlf = literal('\r\n')

const requestLine = transform(
  sequence(method, sp, requestTarget, sp, httpVersion, crlf),
  ([m, , target, , [, ver]]) => ({ method: m, target, version: `HTTP/${ver}` } satisfies RequestLine)
)

// --- Hand-written reference parser ---
function referenceParser(input: string): RequestLine | null {
  const match = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) ([^\s]+) HTTP\/(1\.[01])\r\n/.exec(input)
  if (!match) return null
  return { method: match[1]!, target: match[2]!, version: `HTTP/${match[3]!}` }
}

const cases = [
  'GET / HTTP/1.1\r\n',
  'POST /api/users HTTP/1.0\r\n',
  'DELETE /resource/123 HTTP/1.1\r\n',
  'OPTIONS * HTTP/1.1\r\n',
]

describe('HTTP request line — runtime parity', () => {
  for (const input of cases) {
    it(`parses: ${JSON.stringify(input)}`, () => {
      const ref = referenceParser(input)
      const result = parse(requestLine, input)

      expect(ref).not.toBeNull()
      expect(result.ok).toBe(true)

      if (result.ok && ref) {
        expect(result.value).toEqual(ref)
      }
    })
  }

  it('fails on unknown method', () => {
    const ref = referenceParser('BREW / HTTP/1.1\r\n')
    const result = parse(requestLine, 'BREW / HTTP/1.1\r\n')
    expect(ref).toBeNull()
    expect(result.ok).toBe(false)
  })
})

describe('HTTP request line — compiled parity', () => {
  const compiled = compile(requestLine)

  for (const input of cases) {
    it(`parses: ${JSON.stringify(input)}`, () => {
      const interpreted = parse(requestLine, input)
      const result = compiled.parse(input)
      expect(result.ok).toBe(interpreted.ok)
      if (result.ok && interpreted.ok) {
        expect(result.value).toEqual(interpreted.value)
        expect(result.span).toEqual(interpreted.span)
      }
    })
  }

  it('fails on unknown method', () => {
    const result = compiled.parse('BREW / HTTP/1.1\r\n')
    expect(result.ok).toBe(false)
  })
})
