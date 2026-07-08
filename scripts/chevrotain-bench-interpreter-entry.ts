/**
 * Browser entry for Chevrotain.io JSON benchmark — Parséman interpreter path.
 * Bundled to a single IIFE that exposes window.parse (no compile() / macro).
 */
import { jsonRecognize } from '../examples/json/chevrotain-bench.ts'

declare global {
  interface Window {
    parse: (input: string) => ReturnType<typeof jsonRecognize.parse>
  }
}

window.parse = function parse_json_parseman_interpreted(input: string): ReturnType<typeof jsonRecognize.parse> {
  const result = jsonRecognize.parse(input)
  if (!result.ok) {
    throw new SyntaxError(
      'JSON parse error at offset ' + result.span.start +
      ': expected ' + result.expected.join(' or '),
    )
  }
  return result
}
