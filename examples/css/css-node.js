// The CSS example's tree node, built by a `new` call rather than an object literal: a
// `new` call has no allocation site, so V8 cannot pretenure the nodes a parse keeps.
// The prototype is `Object.prototype`, so each node is a plain object. Plain JavaScript
// because TypeScript cannot declare a function constructor without a cast;
// `css-node.d.ts` types it.

function CssSpan(start, end) {
  this.start = start
  this.end = end
}

export function CssNodeObject(type, start, end, children, rawCount, triviaLog) {
  this._tag = 'node'
  this.type = type
  this.span = new CssSpan(start, end)
  this.children = children
  this.rawCount = rawCount
  this.triviaLog = triviaLog
}

CssSpan.prototype = Object.prototype
CssNodeObject.prototype = Object.prototype
