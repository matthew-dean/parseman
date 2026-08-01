# `choice()` decides disjointness before `g.X` arms resolve

Status: CONFIRMED, unfixed. Measured on `origin/release/0.47.0` @ `f2b0e44`.
Probes: `scratchpad/leftfactor/disjoint-probe.ts`, `scratchpad/leftfactor/disjoint-payload.ts`.

## What happens

`src/combinators/choice.ts:35` computes

    const disjoint = areDisjoint(parsers.map(p => p._meta.firstSet))
                     && parsers.every(p => !matchesEmpty(p))

inside `choice()`, i.e. at CONSTRUCTION. A `g.X` arm inside a `rules()` factory is an
unresolved ref at that moment, and an unresolved ref reports `firstSet: { kind: 'any' }`.
`any` overlaps everything, so `areDisjoint` is false and the choice is recorded
non-disjoint permanently — even though `.define()` then makes the arms provably
disjoint.

Measured, same three disjoint literals, two spellings:

    choice(literal a, literal b, literal c)      disjoint=true   firstSet=ranges
    choice(g.A, g.B, g.C)                        disjoint=false  firstSet=any
    choice(g.Paren, g.Brack, g.Word) recursive   disjoint=false  firstSet=any
    the same three arms spelled non-recursively  disjoint=true   firstSet=ranges

After `.define()` the arms' first-sets ARE `ranges`. The information exists; it is
consumed too early.

It also PROPAGATES: the choice's own `firstSet` is recorded `any`, so any enclosing
choice that takes it as an arm is likewise recorded non-disjoint.

## This is NOT interpreter-only

The brief that reached this lane said codegen is unaffected. It is not:

  - interpreter: `choice.ts:90` gates the O(1) first-char dispatch on the same
    construction-time `disjoint`;
  - codegen: `codegen.ts:2066` (`if (def.disjoint)`) and `codegen.ts:1592`
    (`if (def.disjoint) return null`, "DISPATCH IS NEVER TRADED AWAY") read the same
    stale `_def.disjoint`.

So a recursive grammar loses its O(1) dispatch on BOTH engines. There is no mis-parse —
firstMatch is correct, just slower — which is why nothing caught it.

## What a fix must preserve, and one hazard that turned out fine

Making a previously-non-disjoint choice dispatch changes WHICH arms are attempted, so
the natural worry is the failure payload: firstMatch accumulates `expected` across
arms, dispatch selects one. Measured (`disjoint-payload.ts`), for the direct-vs-`g.X`
spellings of the same grammar, over `'z'`, `''`, `'ab'`, `'a'`:

    0 of 4 inputs differ — whole-result JSON identical on both paths.

So the two paths already agree on results, and resolving disjointness later is
result-preserving for this shape. That removes the most obvious blocker. It is four
inputs on one shape, not a proof: the fix still needs the engine-parity suite plus the
byte-identity oracle on all four dialects, because it WILL move compiled bytes
(dispatch replacing firstMatch is the whole point).

## Shape of the fix

Both readers need the RESOLVED first-sets:

  - interpreter: compute `disjoint` + `asciiDispatch` lazily on first parse and
    memoize — by then every ref is defined;
  - codegen: derive disjointness from the resolved arms at emit time rather than
    reading `_def.disjoint`.

Fixing only one side makes the engines disagree on strategy, which is why they must
move together.

## Why this is a G20 violation

Two equivalent grammars — the same arms, one spelled recursively — compile to
different artifacts and take different dispatch strategies. The spelling, not the
grammar, decides.
