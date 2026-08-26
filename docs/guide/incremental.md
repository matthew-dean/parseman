# Incremental re-parsing

Editors re-parse on every keystroke. Re-parsing the whole document each time
is wasted work when all that changed is one character. `parseDoc` wraps a
parse in a document that re-parses **incrementally** on edits, sharing
untouched nodes by reference instead of rebuilding them.

::: warning Experimental
`parseDoc` / `edit()` is **experimental**, and the API may still change. It's
correct today — every `edit()` returns a tree structurally identical to a
full re-parse, falling back to one whenever reuse can't be proven safe — but
the surface itself isn't frozen. Pin your version and expect the occasional
rough edge.
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

- The **`registry`** is the object `rules()` returns — rule name mapped to
  parser function. The parser functions themselves stay stateless; all the
  incremental state lives in the doc.
- **`rootRule`** names which entry in the registry to parse from.
- Each rule's `type` string has to match its registry key — that's how
  `edit()` knows which rule to re-parse.

## How `edit()` works

`edit()` finds the smallest node containing the change, re-parses just that
rule from its start offset using the node's saved `state`, and grafts the
result back in once the new span's end lands where the edit's delta predicted
it would. Everything else — every node the edit didn't touch — is shared by
reference between the old doc and the new one. A keystroke deep in a large
file re-parses one small subtree, not the whole document.

### Spans are parent-relative

An incremental doc's `tree` stores each node's `span` **relative to its
parent's start** (the root sits at 0). That's what keeps a length-changing
edit cheap: a subtree sitting *after* the edit slides along as a unit with
its parent, so its own offsets never change, and the whole subtree can be
**shared by identity** with no per-node rewrite. An overtype and a character
insert both end up close to free.

You get absolute positions two ways:

```ts
doc.spanAt(path)        // O(depth) cursor — absolute span of the node at a child-index path
absolutizeCST(doc.tree) // O(nodes) — the whole tree with absolute spans, when you need it
```

Reach for `spanAt` when you just need the handful of nodes an editor queries
per keystroke, and save `absolutizeCST` for when a consumer genuinely needs
the whole absolute tree at once. (A fresh, non-incremental `node().parse()`
result is unaffected by any of this — its spans are still absolute, as
always.)

### Structural edits: opt-in list reuse

Insert or delete a *whole element* in a large collection — think "add a line
at the top of a big array" — and by default the whole collection re-parses.
Pass `{ structuralReuse: true }` and `edit()` instead re-parses only the
disturbed span, reusing the collection's untouched tail elements by identity.
That turns the edit from O(list) into O(edit + trailing siblings):

```ts
let doc = parseDoc(registry, 'Stylesheet', src, { structuralReuse: true })
```

This stays **sound automatically** — you don't have to promise anything about
your grammar. `parseDoc` reads the grammar and only ever splices a rule it
can *prove* is a genuine repetition (`many` / `sepBy` / `oneOrMore`). Take a
fixed-arity sequence of same-typed tokens like `Triple = Num ',' Num ',' Num`
— its CST children look exactly like a three-element list, but the grammar
underneath is a plain `sequence` with no repetition in it. So it's never
spliced, and falls back to a full, correct reparse instead. `edit()` always
returns something structurally identical to a fresh parse, flag or no flag.

For `parseDoc` to prove any of this, pass it the **`rules()` combinators** as
the registry, as the examples above do — that's what it inspects. Pass bare
parse *functions* instead and there's no grammar left to inspect, so
structural reuse just doesn't engage (still correct, just no speedup).
Turning it on costs no safety: on top of the grammar check, every splice is
guarded by an exact-tiling check on the reparsed span, a lookahead probe, and
a stateless-tail check. See the
[incremental re-parse benchmark](./benchmarks#incremental-re-parse) for how
the three edit kinds compare to Lezer.

Docs are immutable, so `edit()` returns a new one and leaves the old one
intact — handy for undo stacks and time-travel debugging.

## In an editor extension

Keep one registry per language and one doc per open document. Each keystroke
hands you the changed range as byte offsets — pass them straight to
`edit()`:

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

By default, grafting replaces one child by shallow-spreading its parent. Some
ASTs can't be shallow-spread — class instances with private fields, say — so
for those, pass `opts.rebuild(node, children)` to control how a parent gets
reconstructed:

```ts
const doc = parseDoc(registry, 'Program', src, {
  rebuild: (node, children) => node.withChildren(children),
})
```

With a custom `rebuild`, a length-changing edit falls back to a full
reparse — the graft can't safely slide the span of a class instance, so
correctness wins over the fast path, and `structuralReuse` is skipped along
with it. Same-length edits still graft incrementally. Plain object trees, the
default, get the incremental path either way.

## Build a CST from a composed grammar

If your grammar is [composed](./extending) from `node()` rules that build an
evaluator AST, editor features usually want a plain **positioned CST**
instead. Pass a build host via `opts.build` and it threads through every
(re)parse, so `.edit()` produces the same CST a fresh parse would, on the
same grammar:

```ts
import { parseDoc, cstBuildHost } from 'parseman'

let doc = parseDoc(registry, 'Stylesheet', src, { build: cstBuildHost })
doc = doc.edit(from, to, text)   // re-parsed subtrees are CST nodes too
```

Leave `build` unset to use the grammar's own builders instead. (This is the
same `ctx.build` host that `compose()` grammars accept — see
[`cstBuildHost`](../reference/api#cstbuildhost).)

## Pairs with error recovery

Incremental docs earn their keep on *broken* input — the code an editor sees
mid-keystroke is invalid more often than not. Pair this with [error
recovery](./error-recovery) so a syntax error in one region doesn't take down
the tree for the rest of the document.
