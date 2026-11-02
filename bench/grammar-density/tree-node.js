// Tree nodes for the bench fixtures, built the way a grammar should build the nodes
// it keeps: by a `new` call, which has no allocation site for V8 to pretenure, with
// `Object.prototype` as the prototype so each node is a plain object. Plain JavaScript
// because TypeScript cannot declare a function constructor without a cast;
// `tree-node.d.ts` types it. See `src/cst/plain.d.ts` for the mechanism.

export function TreeSpan(start, end) {
  this.start = start
  this.end = end
}

export function TreeNode(type, start, end, children, rawCount, triviaLen) {
  this.type = type
  this.span = new TreeSpan(start, end)
  this.children = children
  this.rawCount = rawCount
  this.triviaLen = triviaLen
}

// A node that keeps the span object parseman passed its builder, so a regression in how
// parseman builds spans reaches a long-lived tree (`bench/pretenure-check.ts`).
export function SpanKeepingNode(type, span, children) {
  this.type = type
  this.span = span
  this.children = children
}

TreeSpan.prototype = Object.prototype
SpanKeepingNode.prototype = Object.prototype
TreeNode.prototype = Object.prototype
