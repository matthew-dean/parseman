/**
 * Piece models for the inlining-cliff experiment.
 *
 * These are FAITHFUL REDUCTIONS of three real hot bodies in this repo, kept to the
 * strict path (the one that actually runs) and stripped of trivia/recovery/gating so
 * that the only thing varying between configurations is what the experiment varies:
 *
 *   seq     <- src/combinators/sequence.ts  `parse()` strict loop (the `for` over
 *              `parsers[i].parse(input, cur, ctx)` with `result.ok` / `result.span.end`)
 *   choice  <- src/combinators/choice.ts    disjoint first-char dispatch arm
 *              (`asciiDispatch[code]` then one `parsers[idx].parse(...)`)
 *   many    <- src/combinators/repeat.ts    `many()` strict `while (cur < input.length)`
 *              loop over `combinator.parse(...)`
 *
 * Written as plain ESM, NOT TypeScript, on purpose: the experiment measures what V8
 * does with a specific function body, and running the source through tsx/esbuild
 * would put a transform between the authored body and the measured one.
 *
 * The invariant that makes the numbers comparable: every site does the SAME amount of
 * work per `parse()` call regardless of N. Only the identity (and optionally the
 * hidden class) of the leaves differs between sites.
 */

const FAIL = { ok: false, expected: [], span: { start: 0, end: 0 } }

/** Distinct property names used to mint distinct-but-same-size hidden classes. */
const SHAPE_NAMES = Array.from({ length: 64 }, (_, i) => `_shape${i}`)

/**
 * A leaf literal matcher. `shapeId === null` => every leaf shares one hidden class.
 * `shapeId === k` => this leaf carries a uniquely named extra field, giving it a
 * distinct (but same-sized) fast map.
 */
export function makeLeaf(text, shapeId) {
  const len = text.length
  const base = {
    _tag: 'literal',
    _meta: { firstSet: text.charCodeAt(0), canMatchNewline: false, isTrivia: false },
    _def: { tag: 'literal', text },
    parse(input, pos, _ctx) {
      if (input.startsWith(text, pos)) {
        return { ok: true, value: text, span: { start: pos, end: pos + len } }
      }
      return FAIL
    },
  }
  if (shapeId === null) return base
  base[SHAPE_NAMES[shapeId % SHAPE_NAMES.length]] = 1
  return base
}

/**
 * A leaf whose BYTECODE SIZE is controllable, for bracketing V8's inlining budgets
 * (--max-inlined-bytecode-size-small=27, --max-inlined-bytecode-size=460,
 * --max-inlined-bytecode-size-cumulative=920, --max-inlined-bytecode-size-absolute=4600).
 *
 * The padding sits behind `if (pos < 0)`, which never holds for a real parse and which
 * TurboFan cannot fold away, so BYTECODE grows while EXECUTED WORK stays constant. A
 * size sweep that also changed the work per op would price the work, not the budget.
 *
 * Generated source (hence `new Function`) because bytecode size is the independent
 * variable here and there is no other way to dial it. The generated leaf is otherwise
 * byte-for-byte the same shape as `makeLeaf`'s.
 */
export function makeSizedLeaf(text, shapeId, pad) {
  const padSrc = Array.from(
    { length: pad },
    (_, j) => `    acc = (acc * 31 + input.charCodeAt(pos + ${j % 7})) | 0`,
  ).join('\n')
  const src = `
const len = text.length
return {
  _tag: 'literal',
  _meta: { firstSet: text.charCodeAt(0), canMatchNewline: false, isTrivia: false },
  _def: { tag: 'literal', text },
  parse(input, pos, _ctx) {
    if (pos < 0) {
      let acc = 0
${padSrc}
      return acc
    }
    if (input.startsWith(text, pos)) {
      return { ok: true, value: text, span: { start: pos, end: pos + len } }
    }
    return FAIL
  },
}`
  // eslint-disable-next-line no-new-func
  const base = new Function('text', 'FAIL', src)(text, FAIL)
  if (shapeId !== null) base[SHAPE_NAMES[shapeId % SHAPE_NAMES.length]] = 1
  return { leaf: base, src }
}

/** Cheap, never-taken liveness pin for k captured variables (see notes). */

/**
 * sequence(): ONE FunctionLiteral for `parse`. N calls to this factory produce N
 * closures from the same CreateClosure site — the exact configuration the repo's
 * design premise says is fatal.
 */
export function makeSeq(parsers, caps) {
  const def = { tag: 'sequence', parsers, valueUnused: false }
  const meta = { firstSet: parsers[0]._meta.firstSet, canMatchNewline: false, isTrivia: false }
  const c0 = caps[0], c1 = caps[1], c2 = caps[2], c3 = caps[3]
  const c4 = caps[4], c5 = caps[5], c6 = caps[6], c7 = caps[7]
  return {
    _tag: 'sequence',
    _meta: meta,
    _def: def,
    parse(input, pos, ctx) {
      // `pos < 0` never holds for a real parse, but TurboFan cannot prove it, so the
      // captures stay live in the context without costing more than one compare/op.
      if (pos < 0) return [c0, c1, c2, c3, c4, c5, c6, c7]
      const values = def.valueUnused ? undefined : []
      let cur = pos
      for (let i = 0; i < parsers.length; i++) {
        const result = parsers[i].parse(input, cur, ctx)
        if (!result.ok) return result
        if (values !== undefined) values.push(result.value)
        cur = result.span.end
      }
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}

/** choice(): disjoint O(1) first-char dispatch, one arm executed. */
export function makeChoice(parsers, caps) {
  const asciiDispatch = new Int8Array(128).fill(-1)
  for (let i = 0; i < parsers.length; i++) asciiDispatch[parsers[i]._meta.firstSet] = i
  const def = { tag: 'choice', parsers, disjoint: true }
  const meta = { firstSet: -1, canMatchNewline: false, isTrivia: false }
  const c0 = caps[0], c1 = caps[1], c2 = caps[2], c3 = caps[3]
  const c4 = caps[4], c5 = caps[5], c6 = caps[6], c7 = caps[7]
  return {
    _tag: 'choice',
    _meta: meta,
    _def: def,
    parse(input, pos, ctx) {
      if (pos < 0) return [c0, c1, c2, c3, c4, c5, c6, c7]
      const code = pos < input.length ? input.charCodeAt(pos) : -1
      const idx = code >= 0 && code < 128 ? asciiDispatch[code] : -1
      if (idx >= 0) {
        const result = parsers[idx].parse(input, pos, ctx)
        if (result.ok) return result
        return FAIL
      }
      return FAIL
    },
  }
}

/** many(): strict greedy repetition loop. */
export function makeMany(combinator, caps) {
  const def = { tag: 'many', combinator, valueUnused: false }
  const meta = { firstSet: combinator._meta.firstSet, canMatchNewline: false, isTrivia: false }
  const c0 = caps[0], c1 = caps[1], c2 = caps[2], c3 = caps[3]
  const c4 = caps[4], c5 = caps[5], c6 = caps[6], c7 = caps[7]
  return {
    _tag: 'many',
    _meta: meta,
    _def: def,
    parse(input, pos, ctx) {
      if (pos < 0) return [c0, c1, c2, c3, c4, c5, c6, c7]
      const values = def.valueUnused ? undefined : []
      let cur = pos
      let count = 0
      while (cur < input.length) {
        const item = combinator.parse(input, cur, ctx)
        if (!item.ok) break
        if (item.span.end === cur) break
        if (values !== undefined) values.push(item.value)
        count++
        cur = item.span.end
      }
      return { ok: true, value: values, span: { start: pos, end: cur }, count }
    },
  }
}

export const FACTORIES = { seq: makeSeq, choice: makeChoice, many: makeMany }

/** Capture vectors: k live captured variables, the rest are the same constant. */
export function capsFor(k) {
  const caps = new Array(8).fill(0)
  for (let i = 0; i < k; i++) caps[i] = i + 1
  return caps
}

/**
 * Build N sites of one piece kind.
 *
 * shapes: 'identical' => all leaves share one hidden class.
 *         'distinct'  => site i's leaves carry a uniquely named field.
 *
 * chain: when true, the piece's terms are themselves shared pieces (a `choice` site),
 *        so we can see whether the cliff compounds through a call chain.
 */
export function buildSites(kind, n, shapes, captureCount, chain, leafPad) {
  const caps = capsFor(captureCount)
  const sites = []
  const inputs = []
  // `leafPad` swaps in size-controlled leaves. A cold twin is kept so its bytecode
  // size can be read with %DebugPrint: a function that has already tiered up prints
  // `- code: <Code TURBOFAN_JS>` and NO `- bytecode:` line, so the hot leaf cannot be
  // asked its own size.
  const mkLeaf = leafPad
    ? (t, sid) => makeSizedLeaf(t, sid, leafPad).leaf
    : (t, sid) => makeLeaf(t, sid)
  const coldLeafTwin = leafPad ? makeSizedLeaf('a', null, leafPad).leaf : makeLeaf('a', null)
  for (let i = 0; i < n; i++) {
    const shapeId = shapes === 'distinct' ? i : null
    if (kind === 'seq') {
      let terms
      if (chain) {
        terms = [
          makeChoice([mkLeaf('a', shapeId), mkLeaf('b', shapeId)], caps),
          makeChoice([mkLeaf('c', shapeId), mkLeaf('d', shapeId)], caps),
          makeChoice([mkLeaf('e', shapeId), mkLeaf('f', shapeId)], caps),
        ]
      } else {
        terms = [mkLeaf('a', shapeId), mkLeaf('c', shapeId), mkLeaf('e', shapeId)]
      }
      sites.push(makeSeq(terms, caps))
      inputs.push('ace')
    } else if (kind === 'choice') {
      const arms = chain
        ? [
            makeSeq([mkLeaf('a', shapeId), mkLeaf('c', shapeId)], caps),
            makeSeq([mkLeaf('b', shapeId), mkLeaf('d', shapeId)], caps),
            makeSeq([mkLeaf('e', shapeId), mkLeaf('f', shapeId)], caps),
          ]
        : [mkLeaf('a', shapeId), mkLeaf('b', shapeId), mkLeaf('e', shapeId)]
      sites.push(makeChoice(arms, caps))
      inputs.push(chain ? 'ac' : 'a')
    } else {
      const body = chain
        ? makeChoice([mkLeaf('a', shapeId), mkLeaf('b', shapeId)], caps)
        : mkLeaf('a', shapeId)
      sites.push(makeMany(body, caps))
      inputs.push('aaaaaaaa')
    }
  }
  return { sites, inputs, coldLeafTwin }
}

/**
 * Per-site MONOMORPHIC wrapper. In JS the only way to get a genuinely distinct
 * FunctionLiteral per site is to generate source, so this is `new Function` — the
 * very thing the shipped design used and that broke the CSP guarantee. Here it is
 * only a measurement instrument: it tells us what the per-site body BUYS, and its
 * `bytes` field is the price.
 */
export function wrapSites(sites) {
  let bytes = 0
  const wrapped = sites.map((site, i) => {
    const src = `return {
  _tag: ${JSON.stringify(site._tag)},
  _meta: inner._meta,
  _def: inner._def,
  site: ${i},
  parse(input, pos, ctx) { return inner.parse(input, pos, ctx) },
}`
    bytes += src.length
    // eslint-disable-next-line no-new-func
    return new Function('inner', src)(site)
  })
  return { wrapped, bytes }
}

/**
 * THE CONTROL THAT DECIDES WHETHER A PER-SITE BODY IS BUYING ANYTHING.
 *
 * Same extra call level as `wrapSites`, same object shape, same call depth — but ONE
 * FunctionLiteral shared by all N trampolines instead of N generated ones, and ZERO
 * generated bytes.
 *
 * This exists because the benchmark's own `round()` is the caller, and `round` sees a
 * DIFFERENT thing in the two arms it was originally compared across: without a wrapper
 * it calls one shared literal (N closures); with one it calls N distinct literals. Any
 * difference between those two could be a property of `round`, not of wrappers. If this
 * shared trampoline matches the generated per-site wrapper, then whatever the wrapper
 * was buying is bought by the extra call level alone, and the per-site bytes buy
 * nothing.
 */
export function wrapSitesShared(sites) {
  const wrapped = sites.map((inner, i) => ({
    _tag: inner._tag,
    _meta: inner._meta,
    _def: inner._def,
    site: i,
    parse(input, pos, ctx) { return inner.parse(input, pos, ctx) },
  }))
  return { wrapped, bytes: 0 }
}

/**
 * Control for `wrapSites`. Identical per-site FunctionLiteral, identical call depth,
 * identical bytes-per-site to within the index literal — the ONLY difference is that
 * `inner` arrives through an array element instead of a captured binding, so it is not
 * a constant TurboFan can fold through.
 *
 * If the plain wrapper's win comes from constant-folding the captured `inner` (and
 * thence the shared body's own captured callee), this variant gives it back. If the
 * win survives here, the explanation is something else and the constant-folding
 * reading is wrong.
 */
export function wrapSitesIndirect(sites) {
  let bytes = 0
  const box = { all: sites }
  const wrapped = sites.map((site, i) => {
    const src = `return {
  _tag: ${JSON.stringify(site._tag)},
  _meta: box.all[${i}]._meta,
  _def: box.all[${i}]._def,
  site: ${i},
  parse(input, pos, ctx) { return box.all[${i}].parse(input, pos, ctx) },
}`
    bytes += src.length
    void site
    // eslint-disable-next-line no-new-func
    return new Function('box', src)(box)
  })
  return { wrapped, bytes }
}

export function makeCtx() {
  return { trivia: false, state: null, _tolerant: false, _sync: undefined, leaves: [] }
}
