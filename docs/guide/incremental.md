# Incremental re-parsing

Editors re-parse on every keystroke. Re-parsing the whole document each time is wasteful
when a single character changed. `parseDoc` wraps a parse in a document that
re-parses **incrementally** on edits, sharing untouched nodes by reference.

::: warning Experimental
`parseDoc` / `edit()` is **experimental** and its API may change. It's correct — every
`edit()` returns a tree structurally identical to a full re-parse, and reuse falls back to
a full re-parse whenever it can't be proven safe — but it hasn't yet been exercised by a
real language service end to end. It graduates to stable once the **Jess language service
and IDE extension** are built on it, which is what will validate the API surface (edit
batching, diagnostics, folding / semantic-token walks) against production editor use. Until
then, expect rough edges and pin your version.
:::

## `parseDoc`

```ts
import { parseDoc } from 'parseman'

const registry = { Expr, Num }              // straight from rules()
let doc = parseDoc(registry, 'Expr', src)

doc.tree    // your Node root, or null on failure
doc.errors  // ParseFail[], empty on success
doc.input   // the source string

// edit(from, to, replacement) — two byte offsets into the OLD text + the
// replacement. "Select from→to, type replacement" — the three things every
// editor knows on each keystroke. Returns a NEW doc; the old one is untouched.
doc = doc.edit(changeStart, changeStart + changeLength, newText)
```

- The **`registry`** is the object `rules()` returns (rule name → parser function). The
  parser functions stay stateless; all incremental state lives in the doc.
- **`rootRule`** names the entry in the registry to parse from.
- Each rule's `type` string must match its registry key — that's how `edit()` knows which
  rule to re-parse.

## How `edit()` works

`edit()` finds the smallest node containing the change, re-parses just that rule from its
start offset using the node's saved `state`, and grafts the result back in when the new
span end lands where the edit's delta predicts. Nodes unaffected by the edit are shared by
reference between the old and new docs — so a keystroke deep in a large file re-parses one
small subtree, not the whole thing.

Because spans are **absolute** offsets, a length-changing edit shifts every node that comes
*after* it by the delta; nodes *before* the edit stay shared by reference. So an in-place
value edit (overtype, or a character typed into an existing token) is close to free, while
a structural edit costs in proportion to how much of the document follows it. See the
[incremental re-parse benchmark](./benchmarks#incremental-re-parse) for how that compares to
Lezer's buffer-tree reuse — the two engines have opposite sweet spots.

Because docs are immutable, `edit()` returns a new doc and leaves the old one intact —
convenient for undo stacks and time-travel debugging.

## In an editor extension

Keep one registry per language and one doc per open document. Each keystroke gives you the
changed range as byte offsets — pass them straight to `edit()`:

```ts
const docs = new Map<string, ReturnType<typeof parseDoc<Node>>>()

vscode.workspace.onDidOpenTextDocument(d => {
  docs.set(d.uri.toString(), parseDoc(registry, 'Stylesheet', d.getText()))
})

vscode.workspace.onDidChangeTextDocument(event => {
  const uri = event.document.uri.toString()
  let doc = docs.get(uri)!
  for (const change of event.contentChanges) {
    doc = doc.edit(change.rangeOffset, change.rangeOffset + change.rangeLength, change.text)
  }
  docs.set(uri, doc)
  // walk doc.tree for diagnostics, folding ranges, semantic tokens, etc.
})
```

## Class-instance ASTs

The default graft shallow-spreads a parent to replace one child. For ASTs that can't be
shallow-spread — class instances with private fields, say — pass `opts.rebuild(node, children)`
to control how a parent is reconstructed:

```ts
const doc = parseDoc(registry, 'Program', src, {
  rebuild: (node, children) => node.withChildren(children),
})
```

With a custom `rebuild`, a **length-changing** edit falls back to a full reparse — shifting
the absolute spans of a class instance can't be done safely by the graft, so correctness
wins over the incremental fast path. Same-length edits still graft incrementally. Plain
object trees (the default) get the incremental path for both.

## Pairs with error recovery

Incremental docs are most useful on *broken* input — the code an editor sees mid-keystroke
is invalid most of the time. Combine this with [error recovery](./error-recovery) so a
syntax error in one region doesn't blow away the tree for the rest of the document.
