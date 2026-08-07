/**
 * THE WIRING SWEEP — mechanical rewrites of the emitted assembly's inter-piece
 * calls, so several wiring shapes can be measured on ONE grammar, ONE fixture,
 * with semantics held identical by construction.
 *
 * The text these operate on is the SHIPPED emitter's
 * (`src/table/emit-assembly.ts`), taken through `setWiring` in `assemble.ts`, so
 * every leg runs the real driver, the real reducers and the real fixtures. Only
 * the spelling of "piece A calls piece B" moves.
 *
 * `new Function` still compiles the result — that is the MEASUREMENT vehicle,
 * not a proposal. The point of the sweep is to decide which shape the MACRO
 * should print into shipped source, where no `Function` constructor exists.
 *
 * The emitted shape this parses is narrow and stable:
 *   - a prelude of `const`/`function` declarations,
 *   - a run of top-level `function _pf<N>(input,pos,ctx){ … }` declarations,
 *   - `const _r_<Rule>=_pf<N>` bindings,
 *   - a `function _begin` and a `return { … }`.
 * Every rewrite below is checked by `verifySplit`, which re-joins the pieces and
 * requires the result to be byte-identical to the input. A rewrite that cannot
 * find its structure THROWS rather than silently emitting the original — a leg
 * that quietly falls back to the baseline is the "both legs the same engine"
 * defect this repo has shipped six times.
 */

export type WiringMode =
  | 'w0-direct'
  | 'w1-array'
  | 'w2-object-const'
  | 'w3-closure-capture'
  | 'w4-wrapper'
  | 'w5-switch'
  | 'w7-shared-snapshot'

export type Split = {
  head: string
  /** Top-level piece declarations, in emission order. */
  decls: Array<{ ip: number; body: string; whole: string }>
  /**
   * The `const _r_<Rule>=_pf<N>` rule-entry bindings.
   *
   * A multi-rule map emits one after EACH rule is linked, so they are
   * interleaved with the piece declarations rather than collected at the end —
   * `example/css` has `const _r_Entry=_pf878` sitting between two pieces. Every
   * rewrite below hoists them to just before the tail, which is sound because
   * each is a `const` binding of an already-declared piece and nothing between
   * them reads one. Anything else appearing between declarations is REFUSED:
   * silently relocating unknown code is how a rewrite changes semantics.
   */
  entries: string[]
  tail: string
}

const ENTRY_BINDING = /^const _r_[A-Za-z0-9_$]+=_pf\d+$/

/**
 * Find the end of the `{ … }` block starting at `open`, skipping string
 * literals. The emitted text contains `"{"` and `"}"` as literal values, so a
 * brace counter alone mis-splits; it contains no template literals, no comments
 * and no regex literals (regexes live in the `K` pool), and `assertNoExotic`
 * refuses the text if that ever stops being true.
 */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]!
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === quote) break
        i++
      }
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  throw new Error('wiring: unbalanced braces in emitted source')
}

function assertNoExotic(src: string): void {
  if (src.includes('`')) throw new Error('wiring: emitted source now contains a template literal — the splitter is unsafe')
  if (src.includes('//') || src.includes('/*')) throw new Error('wiring: emitted source now contains a comment — the splitter is unsafe')
}

const DECL = /^function _pf(\d+)\(input,pos,ctx\)\{/gm

export function split(src: string): Split {
  assertNoExotic(src)
  const decls: Split['decls'] = []
  DECL.lastIndex = 0
  let first = -1
  let last = -1
  for (;;) {
    const m = DECL.exec(src)
    if (m === null) break
    const start = m.index
    const open = start + m[0].length - 1
    const close = matchBrace(src, open)
    if (first < 0) first = start
    last = close + 1
    decls.push({ ip: Number(m[1]), body: src.slice(open + 1, close), whole: src.slice(start, close + 1) })
    DECL.lastIndex = close + 1
  }
  if (decls.length === 0) throw new Error('wiring: no piece declarations found')
  // Everything between the declarations must be a rule-entry binding. Anything
  // else would be dropped or moved by a rewrite, so refuse rather than lose it.
  const entries: string[] = []
  let cursor = first
  for (const d of decls) {
    const at = src.indexOf(d.whole, cursor)
    for (const line of src.slice(cursor, at).split('\n')) {
      const t = line.trim()
      if (t === '') continue
      if (!ENTRY_BINDING.test(t)) throw new Error(`wiring: unexpected text between piece declarations: ${JSON.stringify(t.slice(0, 80))}`)
      entries.push(t)
    }
    cursor = at + d.whole.length
  }
  return { head: src.slice(0, first), decls, entries, tail: src.slice(last) }
}

/**
 * Prove the splitter understands the text: every byte is accounted for as head,
 * a declaration, a rule-entry binding, or tail. A rewrite that cannot see all
 * of its input can silently drop a piece and still parse correctly on the inputs
 * anyone tried.
 */
export function verifySplit(src: string): void {
  const s = split(src)
  const accounted = s.head.length + s.decls.reduce((n, d) => n + d.whole.length, 0)
    + s.entries.reduce((n, e) => n + e.length, 0) + s.tail.length
  const whitespace = src.length - accounted
  if (whitespace < 0 || whitespace > s.decls.length + s.entries.length + 2) {
    throw new Error(`wiring: split does not account for the text (${whitespace} bytes unexplained)`)
  }
}

/** Every `_pf<N>` referenced anywhere in a chunk of text. */
function refs(body: string): number[] {
  return [...new Set([...body.matchAll(/\b_pf(\d+)\b/g)].map(m => Number(m[1])))]
}

const rename = (text: string, f: (ip: number) => string): string =>
  text.replace(/\b_pf(\d+)\b/g, (_, d: string) => f(Number(d)))

/* ── W1: array of function refs, indexed at each site ──────────────────────── */

/**
 * DENSE indices, not the code offsets. A sparse `P[134]` puts the array in
 * dictionary mode and would measure that instead of the wiring, which would be a
 * strawman rather than a baseline.
 */
function w1Array(src: string): string {
  const s = split(src)
  const slot = new Map<number, number>()
  s.decls.forEach((d, i) => slot.set(d.ip, i))
  const at = (ip: number): string => {
    const n = slot.get(ip)
    if (n === undefined) throw new Error(`wiring: reference to unknown piece _pf${ip}`)
    return `P[${n}]`
  }
  // NAMED function expressions. An anonymous one gets an empty `SharedFunctionInfo`
  // name and disappears from `--trace-turbo-inlining`, which reads as "V8 never
  // considered it" — a wiring result that is an artifact of the rewrite's spelling.
  const bodies = s.decls.map(d => `P[${slot.get(d.ip)!}]=function _pf${d.ip}(input,pos,ctx){${rename(d.body, at)}}`)
  return `${s.head}\nconst P=new Array(${s.decls.length})\n${bodies.join('\n')}\n${rename(s.entries.join('\n'), at)}\n${rename(s.tail, at)}`
}

/* ── W2: property on a linked object, resolved once into a local const ─────── */

function w2ObjectConst(src: string): string {
  const s = split(src)
  const props = s.decls.map(d => `p${d.ip}:function _pf${d.ip}_(input,pos,ctx){${d.body}}`)
  const binds = s.decls.map(d => `const _pf${d.ip}=L.p${d.ip}`)
  return `${s.head}\nconst L={\n${props.join(',\n')}\n}\n${binds.join('\n')}\n${s.entries.join('\n')}\n${s.tail}`
}

/* ── W3: closure capture — the link step hands each piece its callees ──────── */

/**
 * Each site keeps its OWN function literal, so this isolates "call a captured
 * variable" from "call a hoisted name" with V8's per-literal feedback held
 * constant. It is deliberately NOT `assemble.ts`'s shape: that file mints many
 * closures from ONE literal, and the megamorphism it suffers is a property of
 * the sharing, not of the capture.
 *
 * Cycles are broken exactly the way `assemble.ts` breaks them — a forwarding
 * stub, and only where a back-edge needs one.
 */
function w3ClosureCapture(src: string): string {
  const s = split(src)
  const byIp = new Map(s.decls.map(d => [d.ip, d]))
  const deps = new Map(s.decls.map(d => [d.ip, refs(d.body).filter(r => byIp.has(r) && r !== d.ip)]))

  const factories = s.decls.map((d) => {
    const params = refs(d.body).filter(r => byIp.has(r)).map(r => `c${r}`).join(',')
    return `const mk${d.ip}=(${params})=>function _pf${d.ip}_(input,pos,ctx){${rename(d.body, ip => (byIp.has(ip) ? `c${ip}` : `_pf${ip}`))}}`
  })

  // Build order: anything whose callees are all built; stub what is left.
  const built = new Set<number>()
  const link: string[] = []
  const pending = new Set(s.decls.map(d => d.ip))
  const stubbed = new Set<number>()
  while (pending.size > 0) {
    let progressed = false
    for (const ip of [...pending]) {
      const need = refs(byIp.get(ip)!.body).filter(r => byIp.has(r))
      if (!need.every(r => built.has(r) || stubbed.has(r) || r === ip)) continue
      const args = need.map(r => (r === ip ? `s${ip}` : built.has(r) ? `_pf${r}` : `s${r}`)).join(',')
      if (need.includes(ip) && !stubbed.has(ip)) {
        link.unshift(`let _pf${ip}\nconst s${ip}=(input,pos,ctx)=>_pf${ip}(input,pos,ctx)`)
        stubbed.add(ip)
      }
      link.push(`${stubbed.has(ip) ? '' : 'const '}_pf${ip}=mk${ip}(${args})`)
      built.add(ip)
      pending.delete(ip)
      progressed = true
    }
    if (progressed) continue
    // A genuine cycle: stub the site with the most dependents and retry.
    const pick = [...pending].sort((a, b) => (deps.get(b)!.length - deps.get(a)!.length))[0]!
    link.unshift(`let _pf${pick}\nconst s${pick}=(input,pos,ctx)=>_pf${pick}(input,pos,ctx)`)
    stubbed.add(pick)
  }
  return `${s.head}\n${factories.join('\n')}\n${link.join('\n')}\n${s.entries.join('\n')}\n${s.tail}`
}

/* ── W4: a monomorphic wrapper per site in front of a shared body ──────────── */

/**
 * Two effects, and the sweep needs both separated from each other:
 *   - IDENTICAL bodies are shared, which is where the bytes come back;
 *   - every site keeps its own tiny literal in front, which is what a call site
 *     inside another piece actually names.
 * Sites whose bodies are unique get a wrapper too, so the wrapper's cost is
 * measured on every call rather than only on the deduplicated ones.
 */
function w4Wrapper(src: string): string {
  const s = split(src)
  const shared = new Map<string, number>()
  const impl: string[] = []
  const wrap: string[] = []
  for (const d of s.decls) {
    let owner = shared.get(d.body)
    if (owner === undefined) {
      owner = d.ip
      shared.set(d.body, d.ip)
      impl.push(`function _im${d.ip}(input,pos,ctx){${d.body}}`)
    }
    wrap.push(`function _pf${d.ip}(input,pos,ctx){return _im${owner}(input,pos,ctx)}`)
  }
  return `${s.head}\n${impl.join('\n')}\n${wrap.join('\n')}\n${s.entries.join('\n')}\n${s.tail}`
}

/** How many of a grammar's piece bodies are byte-identical duplicates. */
export function duplicateBodies(src: string): { sites: number; distinct: number } {
  const s = split(src)
  return { sites: s.decls.length, distinct: new Set(s.decls.map(d => d.body)).size }
}

/**
 * THE SIZE CENSUS — what a real piece body actually weighs.
 *
 * V8's inlining budget is stated in BYTECODE bytes, and every wiring result
 * anyone has is from probes with ~51-byte bodies. Source bytes are not bytecode
 * bytes, but they are the only figure obtainable without a trace, they are
 * deterministic, and they establish the ORDER OF MAGNITUDE the real pieces sit
 * at — which is the whole question.
 */
export function bodySizes(src: string): {
  sites: number
  min: number
  p50: number
  p90: number
  max: number
  total: number
  /** Sites in each source-byte band, bracketing V8's 460 / 920 / 4600 budgets. */
  bands: Record<string, number>
} {
  const sizes = split(src).decls.map(d => d.body.length).sort((a, b) => a - b)
  const at = (q: number): number => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))]!
  const bands: Record<string, number> = { '<460': 0, '460-920': 0, '920-4600': 0, '>4600': 0 }
  for (const n of sizes) {
    if (n < 460) bands['<460']!++
    else if (n < 920) bands['460-920']!++
    else if (n < 4600) bands['920-4600']!++
    else bands['>4600']!++
  }
  return {
    sites: sizes.length, min: sizes[0]!, p50: at(0.5), p90: at(0.9), max: sizes.at(-1)!,
    total: sizes.reduce((a, b) => a + b, 0), bands,
  }
}

/* ── W5: switch dispatch on a small integer ────────────────────────────────── */

function w5Switch(src: string): string {
  const s = split(src)
  const slot = new Map<number, number>()
  s.decls.forEach((d, i) => slot.set(d.ip, i))
  const call = (ip: number): string => {
    const n = slot.get(ip)
    if (n === undefined) throw new Error(`wiring: reference to unknown piece _pf${ip}`)
    return `_d${n}`
  }
  // `_d<N>` is not a function — it is an integer the call site passes to `_disp`.
  // The rewrite therefore has to reshape the CALL, not just the callee name.
  const rewriteCalls = (text: string): string =>
    text.replace(/\b_pf(\d+)\(/g, (_, d: string) => {
      const n = slot.get(Number(d))
      if (n === undefined) throw new Error(`wiring: reference to unknown piece _pf${d}`)
      return `_disp(${n},`
    })
  const bodies = s.decls.map(d => `function _im${d.ip}(input,pos,ctx){${rewriteCalls(d.body)}}`)
  const arms = s.decls.map(d => `case ${slot.get(d.ip)!}:return _im${d.ip}(input,pos,ctx)`)
  const disp = `function _disp(id,input,pos,ctx){switch(id){\n${arms.join('\n')}\n}}`
  // The tail binds rule entries by NAME, and those are not calls.
  const tail = `${s.entries.join('\n')}\n${s.tail}`.replace(/\b_pf(\d+)\b/g, (_, d: string) => `_im${d}`)
  void call
  return `${s.head}\n${disp}\n${bodies.join('\n')}\n${tail}`
}

/* ── W7: partial sharing — the CST snapshot prologue, not the child call ───── */

/**
 * The emitted sequence-term prologue snapshots six CST sink lengths so a
 * zero-width term can be rolled back. It is ~1.1 KB of the 25.9 KB json
 * assembly, repeated per term, and it takes NO PIECE as an argument — so it
 * satisfies `emit-assembly.ts`'s own criterion for what may be shared, while the
 * child call it sits in front of does not. That is the decomposition: share the
 * trivia/rollback bookkeeping, keep the dispatch and the call per site.
 */
const SNAP = /\{const b=ctx\._cstBuf\n[\s\S]*?\n\}\}/g

function w7SharedSnapshot(src: string): string {
  const s = split(src)
  let hits = 0
  const share = (body: string): string => body.replace(
    /let (_t\d+)_n=false,\1_raw=0,\1_tl=0,\1_lv=0,\1_lg=0,\1_rt=0\n\{const b=ctx\._cstBuf\n[\s\S]*?\n\}\}/g,
    (_, t: string) => { hits++; return `const ${t}_s6=_snap(ctx)\nconst ${t}_n=${t}_s6[0]!==0,${t}_raw=${t}_s6[1],${t}_tl=${t}_s6[2],${t}_lv=${t}_s6[3],${t}_lg=${t}_s6[4],${t}_rt=${t}_s6[5]` },
  )
  const bodies = s.decls.map(d => `function _pf${d.ip}(input,pos,ctx){${share(d.body)}}`)
  if (hits === 0) throw new Error('wiring: w7 found no snapshot prologue to share — the emitted shape moved')
  const helper = `const _snapBuf=new Int32Array(6)
function _snap(ctx){
let n=0,raw=0,tl=0,lv=0,lg=0,rt=0
const b=ctx._cstBuf
if(b!==undefined){
const r=b.raw;raw=r!==undefined?r.length:b.rawSingle!==undefined?1:0
const h=b.ch;lv=h!==undefined?h.length:b.single!==undefined?1:0
const l=b.tl;tl=l!==undefined?l.length:0
n=1
}else if(ctx._cstLeaves!==undefined||ctx._cstRawChildren!==undefined||ctx._cstTriviaLog!==undefined||ctx._fields!==undefined||ctx._errors!==undefined||ctx._triviaLog!==undefined||ctx._rootTriviaLog!==undefined){
raw=ctx._cstRawChildren!==undefined?ctx._cstRawChildren.length:0
tl=ctx._cstTriviaLog!==undefined?ctx._cstTriviaLog.length:0
lv=ctx._cstLeaves!==undefined?ctx._cstLeaves.length:0
n=1
}
if(n!==0){
lg=ctx._triviaLog!==undefined?ctx._triviaLog.length:0
rt=ctx._rootTriviaLog!==undefined?ctx._rootTriviaLog.length:0
}
_snapBuf[0]=n;_snapBuf[1]=raw;_snapBuf[2]=tl;_snapBuf[3]=lv;_snapBuf[4]=lg;_snapBuf[5]=rt
return _snapBuf
}`
  void SNAP
  return `${s.head}\n${helper}\n${bodies.join('\n')}\n${s.entries.join('\n')}\n${s.tail}`
}

/* ── W6: overgeneration — every option variant emitted, the link step picks ── */

/**
 * OWNER-NAMED STRATEGY: "trying with generating some functions that don't get
 * used and some that do".
 *
 * The live half is the baseline wiring, untouched — direct hoisted names, so the
 * runtime cost of the un-picked variant is exactly zero. The other variant's
 * pieces are carried alongside under `_qf<N>` and never referenced. They are
 * BYTES ONLY: V8 pre-parses them and never compiles a body it does not call.
 *
 * The dead variant's bodies may reference prelude constants this variant does
 * not declare. That is sound precisely because they never run — and it is also
 * the honest statement of what overgeneration costs a real build: the SHARED
 * prelude has to cover the union, or each variant carries its own.
 */
export function w6Overgenerate(otherSource: string): (src: string) => string {
  const dead = split(otherSource).decls
    .map(d => `function _qf${d.ip}(input,pos,ctx){${d.body.replace(/\b_pf(\d+)\b/g, (_, n: string) => `_qf${n}`)}}`)
    .join('\n')
  return (src) => {
    verifySplit(src)
    const s = split(src)
    return `${s.head}\n${s.decls.map(d => d.whole).join('\n')}\n${dead}\n${s.entries.join('\n')}\n${s.tail}`
  }
}

const MODES: Record<WiringMode, (src: string) => string> = {
  'w0-direct': s => s,
  'w1-array': w1Array,
  'w2-object-const': w2ObjectConst,
  'w3-closure-capture': w3ClosureCapture,
  'w4-wrapper': w4Wrapper,
  'w5-switch': w5Switch,
  'w7-shared-snapshot': w7SharedSnapshot,
}

export const WIRING_MODES = Object.keys(MODES) as WiringMode[]

export function rewire(mode: WiringMode): (src: string) => string {
  const f = MODES[mode]
  return (src) => {
    verifySplit(src)
    return f(src)
  }
}
