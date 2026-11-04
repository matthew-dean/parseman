// The expression language's AST nodes, built by `new` calls rather than object literals:
// a `new` call has no allocation site, so V8 cannot pretenure the nodes a parse keeps
// (see `examples/css/css-node.js`). Each prototype is `Object.prototype`, so every node
// is a plain object. Plain JavaScript because TypeScript cannot declare a function
// constructor without a cast; `lang-node.d.ts` types it.

export function NumberNode(value, span) { this.type = 'number'; this.value = value; this.span = span }
export function BoolNode(value, span) { this.type = 'bool'; this.value = value; this.span = span }
export function IdentNode(name, span) { this.type = 'ident'; this.name = name; this.span = span }
export function BinaryNode(op, left, right, span) {
  this.type = 'binary'
  this.op = op
  this.left = left
  this.right = right
  this.span = span
}
export function UnaryNode(op, operand, span) { this.type = 'unary'; this.op = op; this.operand = operand; this.span = span }
export function CallNode(callee, args, span) { this.type = 'call'; this.callee = callee; this.args = args; this.span = span }
export function IfNode(condition, then, else_, span) {
  this.type = 'if'
  this.condition = condition
  this.then = then
  this.else = else_
  this.span = span
}

for (const F of [NumberNode, BoolNode, IdentNode, BinaryNode, UnaryNode, CallNode, IfNode]) F.prototype = Object.prototype
