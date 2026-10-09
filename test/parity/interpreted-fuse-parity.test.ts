import { describe, it, expect } from 'vitest'
import * as P from '../../src/index.ts'
import { fuseInterpreted, isInterpretedFuse, linkable } from '../../src/compiler/linker.ts'
import { cases } from './helpers/compose-cases.ts'

/**
 * THE feature test: a runtime composition must parse exactly as the compiled table
 * of the same grammar, or every diagnostic built on it describes a parser nobody
 * ships.
 *
 * Runtime `compose()` and `fuseInterpreted()` are the same link (every piece's
 * `rules()` factory re-run against one namespace), so the independent leg is
 * `compile()` of the composition — one encoded, specialised table:
 *
 *   1. the shared compose case battery (`helpers/compose-cases.ts`) — the same cases
 *      that already pin interpreter ≡ macro, so all engines are pinned to one set of
 *      composition shapes: cross-piece refs, composing-wins trivia,
 *      `noTrivia`/`parser({trivia})` overrides, and multi-level composing;
 *   2. a realistic 3-piece stylesheet grammar (recognition piece → dialect delta →
 *      leaf with `node()` builders) over a corpus, compared on ok / end / VALUE, so
 *      the built tree is compared and not just how far each engine got.
 *
 * The comparison is per input and asserts the full result, not a sampled property.
 */

/** Evaluate one case module twice: once with the real `compose()` and once with
 * `compose` REBOUND to `fuseInterpreted`. Same source, so the two paths cannot drift
 * apart through the harness. (A TEST evaluating fixture source; not a runtime path.) */
function evalModule(code: string, lib: Record<string, unknown>, want: string): Record<string, any> {
  const body = code.replace(/^\s*import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '')
  const names = Object.keys(lib)
  // eslint-disable-next-line no-new-func
  return new Function(...names, `${body}\nreturn { ${want} }`)(...names.map(n => lib[n]))
}

const shape = (r: P.RunResult): unknown => ({
  ok: r.ok,
  end: r.ok ? r.span.end : null,
  expected: r.ok ? [] : [...r.expected].sort(),
  value: r.ok ? r.value : undefined,
})

describe('fuseInterpreted ≡ compose over the shared composition battery', () => {
  for (const c of cases) {
    it(c.name, () => {
      const compiled = evalModule(c.src, { ...P }, 'g').g
      const interpreted = evalModule(c.src, { ...P, compose: fuseInterpreted }, 'g').g
      expect(isInterpretedFuse(interpreted)).toBe(true)
      expect(Object.keys(interpreted).sort()).toEqual(Object.keys(compiled).sort())

      // `compose()` at runtime is the same link, so the independent leg is the
      // TABLE: `compile()` of the composition encodes and specialises it.
      const table = P.compile(compiled as Record<string, unknown>)
      for (const input of c.inputs) {
        expect(
          shape(P.run(interpreted[c.entry], input)),
          `${c.name}: fuseInterpreted vs compose on ${JSON.stringify(input)}`,
        ).toEqual(shape(P.run(compiled[c.entry], input)))
        expect(
          shape(P.run(interpreted[c.entry], input)),
          `${c.name}: interpreted vs compiled table on ${JSON.stringify(input)}`,
        ).toEqual(shape(P.run(table[c.entry]!, input)))
      }
    })
  }
})

/* ── A realistic multi-piece grammar + corpus ───────────────────────────────── */

const ws = P.trivia(P.oneOrMore(P.choice(P.regex(/[ \t\n]+/), P.regex(/\/\*[^]*?\*\//))))

type Piece = Record<string, P.Combinator<unknown>>

/** Recognition piece: selectors/values as raw shapes, no semantics. `g.Declaration`
 * and `g.AtRule` are HOLES another piece fills — the cross-piece binding under test. */
const recognition = (): Piece => P.rules({ trivia: ws }, (g: any) => ({
  Stylesheet: P.many(g.Statement),
  Statement: P.choice(g.AtRule, g.Ruleset),
  Ruleset: P.sequence(g.SelectorList, P.literal('{'), P.many(g.Declaration), P.literal('}')),
  SelectorList: P.sepBy(g.Selector, P.literal(',')),
  // A `node()` in the recognition piece is not decoration: a piece with NO node()
  // anywhere compiles to NON-capturing rules (codegen `capturing:` — see the
  // characterization test at the bottom of this file), and a downstream leaf node()
  // would then be handed empty children by the COMPILED fuse only. Real recognition
  // grammars build nodes; a piece that builds none is the degenerate case, pinned
  // separately rather than smuggled into the corpus.
  Selector: P.node('Selector', P.oneOrMore(P.regex(/[.#]?[a-zA-Z][-\w]*/)), (children: any) => ({ sel: children.length })),
  Value: P.oneOrMore(P.choice(P.regex(/#[0-9a-fA-F]{3,6}/), P.regex(/-?\d+(?:\.\d+)?[a-z%]*/), P.regex(/[a-zA-Z][-\w]*/))),
  Declaration: P.sequence(P.regex(/[-a-zA-Z][-\w]*/), P.literal(':'), g.Value, P.literal(';')),
  AtRule: P.node('AtRule', P.sequence(P.literal('@'), P.regex(/[a-z]+/), g.Value, P.literal(';')), (children: any) => ({ at: children.length })),
  rw: ws,
}))

/** Dialect delta: OVERRIDES `Value` so it also admits `$name`, and overrides
 * `Declaration` so a trailing `;` is optional. Both are referenced by the base
 * piece's OWN rules, so this is the open-recursion case: the base's Ruleset must
 * route into the override. */
const dialect = (): Piece => P.rules({ trivia: ws }, (g: any) => ({
  Interpolation: P.node('Interpolation', P.regex(/\$\{[a-z]+\}/), (children: any) => children.length),
  Value: P.oneOrMore(P.choice(
    P.regex(/\$[a-zA-Z][-\w]*/),
    P.regex(/#[0-9a-fA-F]{3,6}/),
    P.regex(/-?\d+(?:\.\d+)?[a-z%]*/),
    P.regex(/[a-zA-Z][-\w]*/),
  )),
  Declaration: P.sequence(P.regex(/[-a-zA-Z$][-\w]*/), P.literal(':'), g.Value, P.optional(P.literal(';'))),
}))

/** Leaf: local semantic reductions over the recognition rules, with `node()` direct
 * builders and its OWN trivia (composing-wins — it must reach the base's rules too). */
const leaf = (): Piece => P.rules({ trivia: ws }, (g: any) => ({
  Document: P.node('Document', P.many(g.Statement), (children: any) => ({ kind: 'doc', n: children.length })),
  Ruleset: P.node(
    'Ruleset',
    P.sequence(g.SelectorList, P.literal('{'), P.many(g.Declaration), P.literal('}')),
    (children: any) => ({ kind: 'rule', parts: children.length }),
  ),
}))

const CORPUS = [
  'a { color: red; }',
  '.x, .y { color: #fff; margin: 0; }',
  '#id { width: 10px }',
  'a { color: $brand; }',
  'a { color: $brand }',
  '@import url;',
  '@import url; a { color: red; }',
  'a{color:red;}b{color:blue;}',
  'a /*c*/ { /*c*/ color /*c*/ : /*c*/ red /*c*/ ; }',
  '.a .b .c { padding: 1px 2px 3px 4px; }',
  'a { color: red; color: blue; color: green; }',
  '',
  '   ',
  'a { }',
  'a { color: ; }',
  'a { color red; }',
  'a { color: red',
  '} a { color: red; }',
  '@ a;',
  'a, { color: red; }',
  '.x{a:1;b:2;c:3;d:4;e:5;f:6;g:7;h:8;i:9;j:10;}',
]

describe('fuseInterpreted ≡ compose ≡ compile on a 3-piece stylesheet grammar over a corpus', () => {
  const items = () => [recognition(), dialect(), leaf()]
  const compiled = P.compose(items())
  const interpreted = fuseInterpreted(items())
  const table = P.compile(compiled as Record<string, unknown>)

  it('fuses the same rule set', () => {
    expect(Object.keys(interpreted).sort()).toEqual(Object.keys(compiled).sort())
  })

  for (const entry of ['Document', 'Stylesheet', 'Ruleset', 'Declaration', 'Value']) {
    it(`agrees on every corpus input from entry ${entry}`, () => {
      for (const input of CORPUS) {
        expect(
          shape(P.run(interpreted[entry]!, input)),
          `entry ${entry} on ${JSON.stringify(input)}`,
        ).toEqual(shape(P.run(compiled[entry]!, input)))
        expect(
          shape(P.run(interpreted[entry]!, input)),
          `table: entry ${entry} on ${JSON.stringify(input)}`,
        ).toEqual(shape(P.run(table[entry]!, input)))
      }
    })
  }

  it('routes the base piece OWN calls through the override (open recursion)', () => {
    // `$brand` is only in the dialect's Value, and `Ruleset` (base piece) reaches it
    // through the base's OWN `g.Declaration` reference — so a full consume here proves
    // the base's internal call was rerouted, not just a top-level entry.
    const input = 'a { color: $brand; }'
    expect(P.run(interpreted.Stylesheet!, input).span.end).toBe(input.length)
    // Without the dialect piece the same base grammar stops at 0 (many() matches empty).
    expect(P.run(fuseInterpreted([recognition()]).Stylesheet!, input).span.end).toBe(0)
    expect(P.run(compiled.Stylesheet!, input).span.end).toBe(input.length)
  })
})

describe('per-piece ambient scanSkip survives the interpreted fuse', () => {
  // The `composeLeaf([recognition…, rules({ trivia, scanSkip }, leafFactory)])` shape
  // real dialect parsers use: `scanSkip` is PER PIECE (opaque units are dialect
  // specific), so a `scanTo` must ignore a `;` hidden inside a double-quoted string.
  const dq = P.sequence(P.literal('"'), P.regex(/[^"]*/), P.literal('"'))
  const items = () => [
    P.rules(() => ({ Filler: P.regex(/#/) })),
    P.rules({ scanSkip: [dq] }, (g: any) => ({
      Entry: P.sequence(g.ToSemi, P.literal(';')),
      ToSemi: P.scanTo(P.literal(';')),
    })),
  ]
  const inputs = ['a;', '"x;y";', '"x;y"z;', 'no terminator']

  it('agrees with compose() on every input', () => {
    const compiled = P.compose(items())
    const interpreted = fuseInterpreted(items())
    const table = P.compile(compiled as Record<string, unknown>)
    for (const input of inputs) {
      expect(shape(P.run(interpreted.Entry!, input)), input)
        .toEqual(shape(P.run(compiled.Entry!, input)))
      expect(shape(P.run(interpreted.Entry!, input)), `table: ${input}`)
        .toEqual(shape(P.run(table.Entry!, input)))
    }
    // …and the skip is actually in force (not "both engines ignored it").
    expect(P.run(fuseInterpreted(items()).Entry!, '"x;y";').span.end).toBe(6)
  })
})

describe('the compiled path no longer diverges on a piece with NO node()', () => {
  /**
   * THIS DIVERGENCE IS GONE, and the test is kept to say so.
   *
   * `compileLinkable` decided PER PIECE whether its rules captured terminals at all: a
   * piece containing no `node()` anywhere compiled to non-capturing rules. The decision
   * was made from the piece ALONE, so a later piece's `node()` over one of its rules was
   * handed EMPTY children, and the interpreted fuse — which has no such compile step —
   * was the one reporting what the grammar actually said.
   *
   * Table composition merges the rule maps and encodes ONCE, so there is no per-piece
   * capture decision left to invalidate: the encoder sees the composed grammar, including
   * the later `node()`, and captures accordingly. Both fuses now agree with the
   * interpreter.
   */
  const bare = () => P.rules({ trivia: ws }, () => ({ Stmt: P.sequence(P.literal('a'), P.literal(';')) }))
  const over = () => P.rules({ trivia: ws }, (g: any) => ({
    Doc: P.node('Doc', P.many(g.Stmt), (children: any) => children.length),
  }))

  it('both fuses keep the children, agreeing with the interpreter', () => {
    expect(P.run(P.compose([bare(), over()]).Doc!, 'a; a;').value).toBe(4)
    expect(P.run(fuseInterpreted([bare(), over()]).Doc!, 'a; a;').value).toBe(4)
  })

  it('adding ANY node() to the piece removes the divergence', () => {
    const withNode = () => P.rules({ trivia: ws }, () => ({
      Stmt: P.sequence(P.literal('a'), P.literal(';')),
      Anchor: P.node('Anchor', P.literal('Z'), (c: any) => c.length),
    }))
    expect(P.run(P.compose([withNode(), over()]).Doc!, 'a; a;').value).toBe(4)
    expect(P.run(fuseInterpreted([withNode(), over()]).Doc!, 'a; a;').value).toBe(4)
  })
})

describe('fuseInterpreted fuse-time contract', () => {
  it('binds a cross-piece hole', () => {
    const base = P.rules((g: any) => ({ Doc: P.sequence(P.literal('x'), g.Tail) }))
    const ext = P.rules(() => ({ Tail: P.literal('y') }))
    const g = fuseInterpreted([base, ext])
    expect(P.run(g.Doc!, 'xy').ok).toBe(true)
  })

  it('reports a referenced-but-undefined rule at FUSE time, naming the referrer', () => {
    const base = P.rules((g: any) => ({ Doc: P.sequence(P.literal('x'), g.Tail) }))
    expect(() => fuseInterpreted([base])).toThrow('rule "Doc" references missing rule "Tail"')
  })

  it('is idempotent — fusing the same items twice does not conflict', () => {
    const base = P.rules((g: any) => ({ Doc: P.sequence(P.literal('x'), g.Tail) }))
    const ext = P.rules(() => ({ Tail: P.literal('y') }))
    const items = [base, ext]
    expect(P.run(fuseInterpreted(items).Doc!, 'xy').ok).toBe(true)
    expect(P.run(fuseInterpreted(items).Doc!, 'xy').ok).toBe(true)
  })

  it('two fusions over one shared piece each keep their own winner — neither touches the piece', () => {
    const shared = P.rules((g: any) => ({ Doc: P.sequence(P.literal('x'), g.Tail) }))
    const y = fuseInterpreted([shared, P.rules(() => ({ Tail: P.literal('y') }))])
    const z = fuseInterpreted([shared, P.rules(() => ({ Tail: P.literal('z') }))])
    expect(P.run(y.Doc!, 'xy').ok).toBe(true)
    expect(P.run(y.Doc!, 'xz').ok).toBe(false)
    expect(P.run(z.Doc!, 'xz').ok).toBe(true)
    expect(P.run(z.Doc!, 'xy').ok).toBe(false)
    // The piece's own hole is still unbound: linking rebuilt the graph instead.
    expect(() => P.run(shared.Doc!, 'xy')).toThrow('used before .define()')
  })

  it('can be fused AGAIN as an item (later piece still wins)', () => {
    const base = P.rules(() => ({ Word: P.regex(/[a-z]+/), Doc: P.regex(/[a-z]+/) }))
    const first = fuseInterpreted([base])
    const second = fuseInterpreted([first, P.rules(() => ({ Doc: P.literal('QQ') }))])
    expect(P.run(second.Doc!, 'QQ').ok).toBe(true)
  })

  it('refuses a borrowed rule object whose graph references a rule the composition defines', () => {
    // A factory may return another grammar's rule object. Its references are that
    // grammar's slots: the interpreter would keep `base`'s Atom while compile() of the
    // composition binds Atom by name, so the two engines would accept different input.
    const base = P.rules((g: Record<string, P.Combinator<unknown>>) => ({ Entry: P.sequence(g.Atom!, P.literal('!')), Atom: P.literal('a') }))
    const override = P.rules(() => ({ Atom: P.literal('b') }))
    const borrowed = P.compose([P.rules(() => ({ Entry: base.Entry })), override])
    expect(() => borrowed.Entry).toThrow(/compose: rule "Entry" is a rule object borrowed from another grammar, and its graph references "Atom"/)
    expect(() => P.compile(borrowed)).toThrow(/rule "Entry" is a rule object borrowed/)
    // A plain map handed to compile() is refused the same way.
    expect(() => P.compile({ Entry: base.Entry, Atom: P.literal('b') } as Record<string, unknown>)).toThrow(/compile: rule "Entry" is a rule object borrowed/)
    // Composing `base` itself is the supported route, and both engines agree on it.
    const composed = P.compose([base, override])
    const table = P.compile(composed)
    for (const [input, ok] of [['b!', true], ['a!', false]] as const) {
      expect(P.run(composed.Entry!, input).ok).toBe(ok)
      expect(P.run(table.Entry!, input).ok).toBe(ok)
    }
  })

  it('links a borrowed rule object that references no rule the composition defines', () => {
    const word = P.rules(() => ({ Word: P.regex(/[a-z]+/) }))
    const base = P.rules((g: Record<string, P.Combinator<unknown>>) => ({ Entry: P.sequence(g.Atom!, P.literal('!')), Atom: P.literal('a') }))
    const cases = [
      [P.compose([P.rules((g: Record<string, P.Combinator<unknown>>) => ({ Doc: P.sequence(g.W!, P.literal(';')), W: word.Word }))]), 'abc;'],
      // base.Entry references base's Atom, which this composition does not define.
      [P.compose([P.rules(() => ({ Doc: base.Entry }))]), 'a!'],
    ] as const
    for (const [composed, input] of cases) {
      expect(P.run(composed.Doc!, input).ok).toBe(true)
      expect(P.run(P.compile(composed).Doc!, input).ok).toBe(true)
    }
  })

  it('links a runtime linkable() artifact through its recipe, and refuses an IR-only one', () => {
    // A runtime compose() result is itself an interpreter link.
    expect(isInterpretedFuse(P.compose([P.rules(() => ({ A: P.literal('a') }))]))).toBe(true)
    const fused = fuseInterpreted([linkable(P.rules(() => ({ A: P.literal('a') })))])
    expect(P.run(fused.A!, 'a').ok).toBe(true)
    // Through compose()'s public map too: its rule names come from the artifact's
    // `keys`, never from the artifact's own fields.
    const composed = P.compose([linkable(P.rules(() => ({ A: P.literal('a') })))])
    expect(Object.keys(composed)).toEqual(['A'])
    expect(P.run(composed.A!, 'a').ok).toBe(true)
    // A table built from a bare map has no recipe: linking it would mean evaluating
    // carried IR, which never happens at runtime.
    expect(() => fuseInterpreted([linkable({ A: P.literal('a') })])).toThrow('has no live rules to link')
  })
})

describe('composeLeaf() is runnable interpreted', () => {
  it('fuses on first rule ACCESS and parses', () => {
    const g = P.composeLeaf([recognition(), dialect(), leaf()]) as unknown as Record<string, P.Combinator<unknown>>
    expect(P.run(g.Document!, 'a { color: $brand; }').ok).toBe(true)
  })

  it('does not fuse at construction — several leaf grammars over one shared piece can be BUILT', () => {
    const shared = recognition()
    const a = P.composeLeaf([shared, dialect(), leaf()])
    const b = P.composeLeaf([shared, dialect(), leaf()])
    expect(Object.keys(a as object).length).toBeGreaterThan(0)
    expect(Object.keys(b as object).length).toBeGreaterThan(0)
  })

  it('stays terminal — a composeLeaf() result cannot be composed again', () => {
    const g = P.composeLeaf([recognition(), dialect(), leaf()])
    expect(() => P.compose([g as unknown as Record<string, unknown>, P.rules(() => ({ Z: P.literal('z') }))]))
      .toThrow('composeLeaf() result is terminal')
  })
})
