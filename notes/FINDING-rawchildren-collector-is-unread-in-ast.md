# `rawChildren` is collected on every leaf, mark and rollback, and nothing reads it

**Status:** OPEN, deferred out of 0.47 by scoping call. Owns a flag-word change,
which is assembly-key adjacent and not a release-week edit.

**Found by:** `lane/capoff`, while establishing that the CST-capture share of the
0.47 emitted-engine profile is *not* the cap site labels.

**Base for every number here:** `6bc265f5b854b256a2e8ea0df5522ca7cfd57770`
(`origin/release/0.47.0`). Grammars are jess's four shipping dialects loaded
through `bench/jess/grammars.ts` at `hostMode: 'ast'`.

## The claim

An AST parse maintains **two** parallel child collectors on every node. One of
them — `rawChildren` — can only be read by a CST host or by a build reducer that
declares a **4th** formal parameter. Neither exists in an `ast` parse of any of
the four shipping grammars. The collector is still filled, still marked, and
still truncated on rollback.

## The mechanism, with line numbers

`emit-assembly.ts:133-142` — `_pushLeafBuf` writes **every** leaf into both
collectors, unconditionally:

    function _pushLeafBuf(ctx,value,s,e){
    const l={_tag:'leaf',value,span:{start:s,end:e}}
    const b=ctx._cstBuf
    if(b.ch!==undefined)b.ch.push(l)          // children
    else if(b.single!==undefined){…}
    else b.single=l
    if(b.raw!==undefined)b.raw.push(l)        // rawChildren — the dead one
    else if(b.rawSingle!==undefined){…}
    else b.rawSingle=l
    }

`emit-assembly.ts:233-238` — `emitMark(buf: true)` reads **both** lengths at
every mark. `emit-assembly.ts:160-181` — `_rbBuf` truncates **both** at every
rollback.

Emitted site counts, css/ast, from `bench/jess/capoff-skips.ts`:

| construct | sites |
|---|---:|
| `_pushLeafBuf` | 206 |
| `_rbBuf` | 678 |
| `_accSet` | 749 |

## The oracle already exists and is called from nowhere

`src/compiler/build-arity.ts:309`:

    /** Build reads its 4th (`rawChildren`) arg? Unknown/unparseable → true (keep capture). */
    export function buildReadsRaw(def: NodeDef): boolean {

`buildReadsRaw` is **exported and never called anywhere in `src/`**. So is
`buildReadsChildren` (`:301`). Their three siblings — `buildReadsTrivia:317`,
`buildReadsState:325`, `buildReadsFields` — are all wired, at
`encode.ts:1008-1010`.

The flag word at `encode.ts:1014-1019` derives six bits:

| bit | meaning | derived from |
|---:|---|---|
| 4 | trivia | `cstOut \|\| captureTrivia \|\| trailingTrivia \|\| derivedTrivia` |
| 8 | state | `cstOut \|\| derivedState` |
| 16 | fields | `parserHasOwnFields && (cstOut \|\| derivedFields)` |
| 32 | collapse | `d.collapse` |
| 64 | unwrap | `d.unwrap` |
| 128 | trailingTrivia | `d.trailingTrivia` |

**There is no bit for raw.** The question `buildReadsRaw` answers has nowhere to
be recorded, which is why the answer is never asked for.

## Arity evidence

`bench/jess/capoff-rawcensus.ts` walks the fused grammar and asks
`confirmedArityForDef` per node def. Every def it reaches in css and less has
confirmed arity **≤ 3** — none declares the 4th parameter, and none is
`structural` or `arity-unconfirmed` (the two fail-open cases that would force
capture legitimately).

That walker **under-reaches**: it finds 7 defs for css against 131 `OP_NODE`
sites, and 5 for less against 259. Treat the arity result as a strong indication,
not a census — a real fix must derive the bit in `encode.ts`, where every def is
seen by construction, rather than trust this walk.

## What a fix costs

A 7th flag bit, plus its consumers:

- `encode.ts:1014-1019` — derive it from `cstOut || buildReadsRaw(d)`, with the
  same fail-open discipline as its siblings.
- `emit-assembly.ts` — a `_pushLeafNoRaw` variant, and `emitMark`/`_rbBuf` forms
  that carry four slots instead of five.
- `assemble.ts` and `exec.ts` — the closure and interpreter twins, so the three
  engines do not disagree on what a node collected.

This changes the `OP_NODE` flag word, which participates in the assembly key.
That is the reason it is not a 0.47 change.

## What it is NOT

It is **not** the cap site labels. Forcing `CAP_OFF` everywhere emits
byte-identical source for these grammars — css/ast is 1049296 bytes either way —
because `skipFor()` only consults `l.cap` when `hasScan` is true
(`emit-assembly.ts:508`), and `triviaScan` was null in every slot of every
grammar on base. Confirmed independently by `exp/mixture` on all four dialects.

It is **not** the `buf` axis being wrong either. `buf: true` selects the *cheap*
mark — five unconditional loads, against a three-way discriminating chain for
`buf: false`. Eliding it would be slower.

And it is **not** an artefact of the pre-`09f3452` stale-assembly defect.
Allocation per parse, `--trace-gc` byte deltas, `benchmark.css`, 100 parses:
`90e115c9` 34.78 MB, `6bc265f` 34.68 MB — a 0.3% difference.

## Caveat on the numbers this note replaces

The widely-relayed figures of 46.3 MB/parse (HEAD) vs 26.8 (0.46) **do not
reproduce**. The controlled measurement above is 34.7 MB/parse on `6bc265f`,
stated with its fixture, size, warmup count, parse count, and the `ok` and
`consumed` totals that prove every parse in the window actually parsed. Do not
carry 46.3/26.8 forward.
