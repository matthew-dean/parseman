/**
 * Parseman CST JSON grammar for benchmarking the trivia-capture path.
 *
 * Exported factories:
 *   buildParsermanCSTJSON()           — interpreted, captureTrivia: true
 *   buildParsermanCSTJSONNoTriv()     — interpreted, captureTrivia: false
 *   buildParsermanCSTJSONCompiled()   — macro/.compile() output, captureTrivia: false
 *
 * Build callbacks use three parameters `(ch, _r, span)` so arity-gated elision
 * skips per-node trivia logging and state cloning on the hot path.
 */
import {
  rules, node, regex, literal, choice, many, sequence, trivia, parser, compile,
  type CSTNode, type CSTLeaf, type CSTError,
} from '../src/index.ts'

const ws = trivia(regex(/[ \t\n\r,]*/))

function mkNode(
  type: string,
  children: ReadonlyArray<CSTNode | CSTLeaf | CSTError>,
  span: { start: number; end: number },
): CSTNode {
  return { _tag: 'node', type, span, state: null, children }
}

function makeCstJsonRoot(captureTrivia: boolean) {
  const stringRe = regex(/"(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/)
  const numberRe = regex(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)

  const { Value } = rules(g => {
    const StringVal = node('StringVal', stringRe, (ch, _r, span) =>
      mkNode('StringVal', ch as CSTNode['children'], span))
    const NumberVal = node('NumberVal', numberRe, (ch, _r, span) =>
      mkNode('NumberVal', ch as CSTNode['children'], span))
    const True = node('True', literal('true'), (ch, _r, span) =>
      mkNode('True', ch as CSTNode['children'], span))
    const False = node('False', literal('false'), (ch, _r, span) =>
      mkNode('False', ch as CSTNode['children'], span))
    const Null = node('Null', literal('null'), (ch, _r, span) =>
      mkNode('Null', ch as CSTNode['children'], span))
    const Object = node(
      'Object',
      sequence(literal('{'), many(sequence(g.StringVal, literal(':'), g.Value)), literal('}')),
      (ch, _r, span) => mkNode('Object', ch as CSTNode['children'], span),
    )
    const Array = node(
      'Array',
      sequence(literal('['), many(g.Value), literal(']')),
      (ch, _r, span) => mkNode('Array', ch as CSTNode['children'], span),
    )
    const Value = node(
      'Value',
      choice(g.Object, g.Array, g.StringVal, g.NumberVal, g.True, g.False, g.Null),
      (ch, _r, span) => mkNode('Value', ch as CSTNode['children'], span),
    )
    return { Value, Object, Array, StringVal, NumberVal, True, False, Null }
  })

  return parser({ trivia: ws, captureTrivia }, Value)
}

const cstJsonInterpTriv = makeCstJsonRoot(true)
const cstJsonInterp = makeCstJsonRoot(false)
const cstJsonCompiled = compile(cstJsonInterp)

function parseOk<T>(r: { ok: boolean; value?: T }): T {
  if (!r.ok) throw new Error('parse failed')
  return r.value as T
}

export function buildParsermanCSTJSON(): (input: string) => unknown {
  return (input: string) => parseOk(cstJsonInterpTriv.parse(input))
}

export function buildParsermanCSTJSONNoTriv(): (input: string) => unknown {
  return (input: string) => parseOk(cstJsonInterp.parse(input))
}

export function buildParsermanCSTJSONCompiled(): (input: string) => unknown {
  return (input: string) => parseOk(cstJsonCompiled.parse(input, 0))
}
