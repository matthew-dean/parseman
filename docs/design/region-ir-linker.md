# Regional lowering evidence and design

Status: compiler-only design and census. No runtime binding, serialization, or
parse strategy is changed by this checkpoint.

## Problem boundary

On the newest grammar graph that both Parseman 0.46 and 0.48 can compile
(`Jess 1641e30d`), the 0.48 CSP closure artifact crosses substantially more
parser-function boundaries than 0.46's source-generated parser. The generated
parser actually executes *more* recognizer and transaction semantic blocks, so
recognizer work and capture/context bookkeeping cannot be the primary cause of
the remaining gap.

The measured closure Piece-call excess over actual generated named-function
calls is 174,575 / 66.8% of all Piece calls for CSS, 342,412 / 55.5% for
`benchmark.less`, and 969,649 / 54.5% for generated Less. Even after excluding
closure literal/regex/token Pieces, the remaining excess is 50.1%, 38.4%, and
37.5% of all Piece calls respectively. This makes a regional linker, rather
than another recognizer micro-cut, the first mechanism with a shelf-scale
ceiling.

## One semantic authority

`RegionIR` is a compiler view over the final, winner-resolved `TableProgram`.
It does not define a second parser and it is not an alternate artifact format.
The compact instruction stream remains the serialized grammar authority.

```ts
type RegionIR = {
  version: 1
  variant: {
    hostCst: boolean
    hostReadsChildren: boolean
    nodeFacts: readonly (readonly [
      ip: number, captureWide: boolean, keepChildren: boolean,
      wantFields: boolean, tracked: boolean,
    ])[]
    trackLines: boolean
    tolerant: boolean
    coverage: boolean
    probe: boolean
    recovery: boolean
  }
  regions: readonly Region[]
  cover: {
    kind: 'cap3+NSVO'
    candidates: readonly {
      rootIp: number; context: SiteLabel; key: string
      ownedIps: readonly number[]; boundaries: number
    }[]
    chunks: readonly {
      rootIp: number; key: string; ownedIps: readonly number[]
      boundaries: readonly { ip: number; reason: BoundaryReason }[]
    }[]
    templates: readonly string[]
  }
  digest: string
}

type SiteLabel = { tri: number; buf: boolean; cap: number }
type BoundaryReason = 'rule' | 'shared-join' | 'recursive-join' | 'cover-split'

type Region = {
  id: number
  rootIp: number
  context: SiteLabel
  nodes: readonly RegionNode[]
  boundaries: readonly RegionBoundary[]
  maximalKey: string
  coverKey: string
}

type RegionNode = {
  localId: number
  ip: number
  opcode: number
  operands: readonly RegionOperand[]
  children: readonly RegionEdge[]
  effects: { authority: 'table-opcode' }
}

type RegionEdge = {
  slot: number
  role: 'child' | 'term' | 'arm' | 'selector' | 'fallback' | 'item' | 'separator'
  target: number | null
  boundary: number | null
}

type RegionBoundary = {
  id: number
  ip: number
  reason: BoundaryReason
}
```

The evidence tranche types every operand of the admitted opcodes: scalar,
callback, constant, trivia, projection, class, expected, and child. Other
opcodes are inventory rows and must remain direct boundaries until their own
typed decoder exists. A numeric class index cannot therefore be mistaken for
an expected-set index, and a child offset cannot survive relocation as a plain
number.

Detailed effect/control lowering is explicitly **GAP** in this checkpoint.
There is deliberately no second effect table. The opcode is
the effect authority (`effects.authority === 'table-opcode'`), and an executable
tranche must introduce one opcode-lowering definition that produces *both* the
closure-template and named spellings. That definition must cover cursor/value,
commit/expected, every capture sink and scoped context, throw restoration, and
reentry scratch publication before any regional body may replace its Pieces.
Until then the IR is compiler-only evidence. The two eventual spellings bind
one selected regional body; they are not independently maintained parsers.

## Region ownership and splitting

A maximal region starts at a rule entry, an `OP_RULE`, or a node whose reachable
indegree is not exactly one. It owns descendants while each descendant has one
incoming edge and is not `OP_RULE`.

- A shared join is compiled once as another region and called through a direct
  captured Piece. It is never cloned into all parents.
- A recursive back-edge ends at a rule/shared boundary and calls that region's
  captured entry. No region recursively expands its own graph.
- A user callback is a direct captured operand, not a parser region boundary.
- A bounded cover split turns an otherwise-local edge into a direct captured
  boundary. The child keeps the existing Piece ABI, so splitting does not add a
  replay, alternate recognizer, or runtime strategy test.
- Context-changing instructions may remain inside a region only after the shared
  opcode lowering owns their exact save/write/restore operations. A context *join* whose
  incoming facts meet to unknown is a shared boundary, not cloned by caller.

The deterministic bounded cover walks child slots in encoded operand order.
When adding the next owned node would exceed the node budget, that edge becomes
a `cover-split` and starts the next chunk. This makes the cover independent of
Map/DFS insertion order and stable under pool relocation.

## Binding without a parallel engine

Every selected `Region` has the same regional control/effect program. The
binder prices two complete spellings:

1. **CSP closure template.** A bounded, prewritten template factory captures
   child Pieces and fixed operands as scalar lexical variables. Its returned
   Piece contains direct calls and structured control flow; it performs no
   opcode switch, `pieces[ip]`, child array walk, route-array walk, or runtime
   “regional versus legacy” branch. Unsupported large motifs are split until a
   template covers every resulting chunk.
2. **Hygienic named body.** Build/macro output may print the same regional
   control/effect program with direct hygienic identifiers. It is selected only
   when its total artifact price is lower. Runtime compilation never invokes
   `Function`; when no prebuilt named body exists, it binds the CSP template.

The selected spelling is fixed before parsing. `compose` first winner-resolves
and encodes one final program, then derives regions. `fold` relocates typed
operands and boundaries. Macro and runtime compilation use the same RegionIR
builder and cover; they differ only in which already-complete spelling wins the
price comparison. A one-node/shared Piece is the smallest regional binding, not
a fallback parser.

The bounded template source is generated at repository build time from the
regional effect/control definition. Checked-in closure templates and the named
printer must carry the generator digest, and a differential mutates one opcode
effect in that definition and requires closure, named, and reference legs to
disagree. This prevents two handwritten semantic authorities.

## Coverage evidence

The RED-proven dynamic edge census uses exact Parseman `4ffce49` and authoritative
Jess `bbda2ec` for current topology. Source, table reference, and closure results
fully consume and have identical digests for all three fixtures.

Maximal unique-ownership regions absorb 71.07% of CSS, 73.05% of
`benchmark.less`, and 73.45% of generated-Less Piece calls. A generic bounded
cover is deliberately admitted at a lower floor: it must remove at least 20%
on all three fixtures before any runtime implementation is reviewed.

The first proposed library is the complete deterministic cap-3 structural cover,
the common behavior-class-zero `NODE -> stable SCOPE -> SEQV(arity 2) -> OPT`
regional motif. It contains no grammar names, instruction offsets, literals, or
Jess-specific predicates. Maximal-region ownership cuts shared and recursive
joins more conservatively than the initial static screen: that reduces the
cap3+NSVO floor to 17.85% CSS / 21.64% benchmark Less / 20.88% generated Less.
One further generic motif, `GATE -> eligible NODE`, raises CSS above the admitted
20% floor while retaining the same join boundaries. The overlapping candidate
screen first reported 24.07% CSS / 23.54% benchmark Less / 23.16% generated
Less, but that credited an edge to every candidate that contained it. The
authoritative non-overlapping chunk selection is lower and is the number that
matters: 21.79%, 23.05%, and 22.47% respectively.

Static context-specialized census: CSS has 146 selected chunks / 56 template
keys; Less has 309 / 103; the union is 127 keys and at most four owned operations
per site. Concatenating the current emitted bodies for one representative of
each selected context-qualified key is a conservative source upper bound of
93,798 raw / 6,170 gzip bytes for CSS, 202,807 / 12,626 for Less, and 247,016 /
14,868 for their union. It is not a package estimate and includes statements a
regional implementation can share. The compiler-only RegionIR evidence itself
changes a fresh package by +300 packed / +20,862 unpacked / +3 entries versus
exact `4ffce49`; it has no runtime integration and makes no performance claim.

The earlier non-region-local source-price screen is retained only as an upper
bound: 106 bounded topology keys, at most five owned operations, 287,360 raw /
17,618 gzip bytes of semantic template source, and a package model of +66,762
packed / +1.45 MB unpacked / +7 entries. It crossed shared joins and therefore
is not the executable cover authority. The region-local library must be priced
again from its own generated closure templates; these numbers must not be quoted
as its implementation size.

For comparison, an exact cap-8 cover has 179 CSS and 322 Less structural keys
but 68--69% raw dynamic coverage. It is not the first library because directly
shipping every exact grammar shape recreates whole-grammar factory bloat. Only
3 CSS and 7 Less normalized cap-8 keys account for the first 20%, which supports
cost-selected named spelling for unusually valuable regions while keeping the
CSP library generic.

## Required RED evidence before runtime binding

- omit one reachable child edge after winner resolution: region inventory must
  differ and the closure gate must fail;
- mutate a typed operand kind while preserving its numeric value: validation
  must reject it;
- reverse child visitation order: stable region/chunk IDs and template keys
  must remain unchanged;
- hide an incoming edge to a shared or recursive node: ownership digest must
  change and the planted plan must fail;
- corrupt a cover split target: closure and named plan digests must disagree;
- mutate one failure/restore effect: reference-versus-closure and
  reference-versus-named differentials must both go RED;
- run the existing full-consumption/digest harness with a truncated-input plant,
  and zero the edge counters to prove the dynamic coverage instrument is live.

No runtime binding should begin until an independent review accepts the schema,
the deterministic cover, and the non-vacuous omission/effect plants.
