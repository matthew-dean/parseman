# Incremental re-parsing

Editors re-parse on every keystroke. Re-parsing the whole document each time is wasteful
when a single character changed. `makeFunctionalDoc` wraps a parse in a document that
re-parses **incrementally** on edits, sharing untouched nodes by reference.

## `makeFunctionalDoc`

```ts
import { makeFunctionalDoc } from 'parseman'

const registry = { Expr, Num }              // straight from rules()
let doc = makeFunctionalDoc(registry, 'Expr', src)

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

Because docs are immutable, `edit()` returns a new doc and leaves the old one intact —
convenient for undo stacks and time-travel debugging.

## In an editor extension

Keep one registry per language and one doc per open document. Each keystroke gives you the
changed range as byte offsets — pass them straight to `edit()`:

```ts
const docs = new Map<string, ReturnType<typeof makeFunctionalDoc<Node>>>()

vscode.workspace.onDidOpenTextDocument(d => {
  docs.set(d.uri.toString(), makeFunctionalDoc(registry, 'Stylesheet', d.getText()))
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
const doc = makeFunctionalDoc(registry, 'Program', src, {
  rebuild: (node, children) => node.withChildren(children),
})
```

## Pairs with error recovery

Incremental docs are most useful on *broken* input — the code an editor sees mid-keystroke
is invalid most of the time. Combine this with [error recovery](./error-recovery) so a
syntax error in one region doesn't blow away the tree for the rest of the document.
