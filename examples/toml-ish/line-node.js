// The config parser's line nodes, built by `new` calls rather than object literals: a
// `new` call has no allocation site, so V8 cannot pretenure the nodes a parse keeps (see
// `examples/css/css-node.js`). Each prototype is `Object.prototype`, so every node is a
// plain object. Plain JavaScript because TypeScript cannot declare a function constructor
// without a cast; `line-node.d.ts` types it.

export function CommentLine() { this.type = 'comment' }
export function SectionLine(name) { this.type = 'section'; this.name = name }
export function EntryLine(key, value) { this.type = 'entry'; this.key = key; this.value = value }

for (const F of [CommentLine, SectionLine, EntryLine]) F.prototype = Object.prototype
