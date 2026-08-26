# Editor / language-server integration

Parseman's editor support follows one principle: **the grammar stays pure
structure, and editor behavior hooks onto it from the outside.** A grammar
describes what a valid document *is* — it doesn't carry recovery policy,
completion lists, or lint rules. Those differ per editor and per project, so
they live in a separate layer keyed by rule and node name, and the grammar
itself never changes to accommodate them.

There are three layers:

1. **The grammar** — combinators (`rules`, `sequence`, `many`, `sepBy`, `node`, …).
   You write it once, it compiles for speed, and it has no IDE surface at all.
2. **Recovery and completions in the compiled parser** — automatic, opt-in at
   compile time, so the compiled artifact an editor actually loads can recover
   past broken input and answer completions on the fast path.
3. **`parseman/language-service`** — an external, grammar-agnostic layer that
   turns the parser's raw signals into editor features like diagnostics and
   semantic completions, configured by whoever's consuming it.

## 1. Compile the grammar with recovery

Recovery sits dormant unless you opt in. A normal strict parse of an opted-in
grammar barely notices it's there — about 1% overhead from the dormant
branches — and the output stays macro-inlinable.

**Build-time (macro):**

```ts
// vite/rollup/esbuild config
parseman({ recovery: true })
```

**Or at runtime:**

```ts
import { compile } from 'parseman'
const parser = compile(grammar, undefined, { recovery: true })
```

Run a recovery-compiled grammar tolerantly, and here's what happens when it
hits a malformed list element: it skips ahead to an *inferred* sync point —
the enclosing delimiter, or a `sepBy`'s separator, with no grammar annotation
needed — embeds a `parseError` node in the CST over the skipped span, and
keeps going. It also records the completions probe along the way. A strict
parse (the default) comes out byte-identical to a grammar with no recovery at
all.

Because the error lives as a node in the tree rather than off in a side
channel, a simple walk finds every diagnostic. And — this matters a lot for
the incremental document below — the error rides inside the subtree it
belongs to, so it survives edit-time reuse instead of getting lost.

## 2. Wrap it in a language service

```ts
import { languageService } from 'parseman/language-service'

const css = languageService(grammar, {
  // lint rules keyed by node type — run over the parsed CST
  diagnostics: {
    Color: (node) =>
      isLegacyHex(node) ? [{ severity: 'warning', message: 'prefer #rrggbb', span: node.span }] : [],
  },
  // semantic completions keyed by the rule the cursor is in
  complete: {
    Declaration: (cx) => valuesFor(cx /* … */).map(label => ({ label })),
  },
})

css.parse(src, { tolerant: true }) // → CST + ParseError[]
css.diagnostics(src)               // → structural errors + your lint rules
css.completionsAt(src, offset)     // → completion items
```

The grammar you pass in stays untouched — the same combinator parses
identically whether or not the service is wrapping it.

`css.parse`, `css.diagnostics`, and `css.completionsAt` are one-shot: each
call re-parses the whole text from scratch. That's fine for a lint-on-save
button, but an editor re-parsing on every keystroke wants an **incremental
document** instead.

## 3. Open an incremental document

Pass the grammar as `{ rules, root }` — a `rules()` registry plus its entry
rule — and you unlock `openDocument`. The document holds a tolerant,
incremental parse: `edit()` re-parses only the span that changed and reuses
everything else, so the tree stays alive even through a broken, mid-typo
keystroke.

```ts
const css = languageService({ rules: grammar, root: 'StyleSheet' }, config)

let doc = css.openDocument(source)
doc.tree            // CST with absolute spans; recovered errors embedded as parseError nodes
doc.diagnostics()   // walks the maintained tree — errors + lint, complete, no full reparse
doc.completionsAt(offset)

// on each editor change:
doc = doc.edit(from, to, replacement)   // incremental; tree survives even mid-typo
```

Because recovered errors live in the tree, an `edit()` that reuses an
untouched region keeps that region's diagnostics for free — no re-deriving
them. Incremental re-parsing and error recovery aren't two separate systems
here; they're one pipeline.

## 4. Wire it into a language server

```ts
const css = languageService({ rules: grammar, root: 'StyleSheet' }, config)
const docs = new Map<string, ReturnType<typeof css.openDocument>>()

connection.onDidOpenTextDocument(({ textDocument: t }) => {
  docs.set(t.uri, css.openDocument(t.text))
  publish(t.uri)
})

connection.onDidChangeTextDocument(({ textDocument, contentChanges }) => {
  let doc = docs.get(textDocument.uri)!
  for (const c of contentChanges) {
    const from = doc /* map c.range → offsets */ , to = from // (via your line index)
    doc = doc.edit(from, to, c.text)
  }
  docs.set(textDocument.uri, doc)
  publish(textDocument.uri)
})

connection.onCompletion(({ textDocument, position }) => {
  const doc = docs.get(textDocument.uri)!
  return doc.completionsAt(offsetOf(position)).map(c => ({ label: c.label, detail: c.detail }))
})

function publish(uri: string) {
  const diags = docs.get(uri)!.diagnostics().map(d => ({
    severity: d.severity === 'error' ? 1 : 2,
    range: rangeOf(d.span),
    message: d.message,
  }))
  connection.sendDiagnostics({ uri, diagnostics: diags })
}
```

## Notes & limits

- **`parseman/language-service` is a tree-shakeable subpath.** If a build-only
  consumer never imports it, it pays nothing for the editor code.
- **`openDocument` needs `{ rules, root }`.** The incremental engine addresses
  rules individually, so a bare single-combinator service only gets the
  one-shot methods — calling `openDocument` on it throws a clear error.
- **Completions still probe the grammar.** `completionsAt` runs a truncated
  parse to work out the expected set — there's no way around that, it's
  inherently a "what could go here" question — but it uses the maintained
  tree to find the rule at the cursor cheaply. Completions run on-demand, not
  on every keystroke, so this stays off the hot path.
- **Completions on incomplete input** map to a semantic handler only when a
  node genuinely completes around the cursor (the rule at the cursor is
  reconstructed by span-containment over the partial CST). Otherwise you get
  the grammar's raw expected-token labels — always useful, just not mapped to
  your domain.
- **Recovery quality is good, not provably optimal.** The sync point comes
  from standard follow-set panic-mode over the grammar's own structure — a
  `sepBy`'s separator, an enclosing delimiter. There are no per-rule recovery
  knobs; recovery follows the grammar's shape, and stays out of both the
  grammar source and the service config.
