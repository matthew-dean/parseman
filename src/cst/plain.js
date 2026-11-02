// Constructors for the objects a parse keeps until it ends. Plain JavaScript on
// purpose: a function constructor whose `prototype` is `Object.prototype` is the only
// spelling that builds a plain object with a `new` call, and TypeScript cannot declare
// one in a `.ts` file without a cast. `plain.d.ts` types them. Why constructors at all,
// and why this is ONE module shared by every bundle: see `plain.d.ts`.

export function PlainSpan(start, end) {
  this.start = start
  this.end = end
}

export function PlainLeaf(value, span) {
  this._tag = 'leaf'
  this.value = value
  this.span = span
}

export function PlainLineSpan(start, end, startLine, startColumn, endLine, endColumn) {
  this.start = start
  this.end = end
  this.startLine = startLine
  this.startColumn = startColumn
  this.endLine = endLine
  this.endColumn = endColumn
}

export function PlainNode(type, span, state, children) {
  this._tag = 'node'
  this.type = type
  this.span = span
  this.state = state
  this.children = children
}

export function PlainTaggedNode(type, tags, span, state, children) {
  this._tag = 'node'
  this.type = type
  this.tags = tags
  this.span = span
  this.state = state
  this.children = children
}

export function PlainField(name, value, span) {
  this.name = name
  this.value = value
  this.span = span
}

export function PlainTriviaField(name, value, span, leading, trailing) {
  this.name = name
  this.value = value
  this.span = span
  this.leading = leading
  this.trailing = trailing
}

// Every field assigned, so the three buffer kinds share one shape. `rawLen` is always a
// count: a field that held `undefined` in most buffers and a number in some would
// generalize and deoptimize the pushes that read it.
export function PlainBuf(rawOnly, noRaw, rawLen) {
  this.rawOnly = rawOnly
  this.noRaw = noRaw
  this.rawLen = rawLen
  this.single = undefined
  this.ch = undefined
  this.rawSingle = undefined
  this.raw = undefined
  this.tl = undefined
}

for (const f of [PlainSpan, PlainLineSpan, PlainLeaf, PlainNode, PlainTaggedNode, PlainField, PlainTriviaField, PlainBuf]) {
  f.prototype = Object.prototype
}
