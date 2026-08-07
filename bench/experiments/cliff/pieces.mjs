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
export function buildSites(kind, n, shapes, captureCount, chain) {
  const caps = capsFor(captureCount)
  const sites = []
  const inputs = []
  for (let i = 0; i < n; i++) {
    const shapeId = shapes === 'distinct' ? i : null
    if (kind === 'seq') {
      let terms
      if (chain) {
        terms = [
          makeChoice([makeLeaf('a', shapeId), makeLeaf('b', shapeId)], caps),
          makeChoice([makeLeaf('c', shapeId), makeLeaf('d', shapeId)], caps),
          makeChoice([makeLeaf('e', shapeId), makeLeaf('f', shapeId)], caps),
        ]
      } else {
        terms = [makeLeaf('a', shapeId), makeLeaf('c', shapeId), makeLeaf('e', shapeId)]
      }
      sites.push(makeSeq(terms, caps))
      inputs.push('ace')
    } else if (kind === 'choice') {
      const arms = chain
        ? [
            makeSeq([makeLeaf('a', shapeId), makeLeaf('c', shapeId)], caps),
            makeSeq([makeLeaf('b', shapeId), makeLeaf('d', shapeId)], caps),
            makeSeq([makeLeaf('e', shapeId), makeLeaf('f', shapeId)], caps),
          ]
        : [makeLeaf('a', shapeId), makeLeaf('b', shapeId), makeLeaf('e', shapeId)]
      sites.push(makeChoice(arms, caps))
      inputs.push(chain ? 'ac' : 'a')
    } else {
      const body = chain
        ? makeChoice([makeLeaf('a', shapeId), makeLeaf('b', shapeId)], caps)
        : makeLeaf('a', shapeId)
      sites.push(makeMany(body, caps))
      inputs.push('aaaaaaaa')
    }
  }
  return { sites, inputs }
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

export function makeCtx() {
  return { trivia: false, state: null, _tolerant: false, _sync: undefined, leaves: [] }
}
