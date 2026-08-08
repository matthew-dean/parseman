/**
 * VERIFIED grammar fixes — the propose → apply → recompile → compare loop.
 *
 * rustc can tell you a suggestion is machine-applicable. It cannot tell you the
 * suggestion is CORRECT: there is no cheap oracle for "this rewrite of your program
 * means the same thing". A parser generator has one. A grammar's whole observable
 * behaviour is the tree it produces for an input, so a rewrite can be applied, the
 * grammar recompiled, a corpus re-parsed, and the two outputs compared byte for byte.
 * Unchanged output is not a heuristic that the rewrite was safe; it is the evidence.
 *
 *     propose  →  apply  →  recompile  →  compare parse output
 *                                          unchanged → PROVEN over this corpus; offer it
 *                                          changed   → WRONG; discard, never show it
 *
 * TWO STATES, NEVER A THIRD
 * -------------------------
 * Every candidate site ends as ACTIONABLE (here is the rewrite, here is the evidence,
 * here is the measured benefit) or LOCATED (here is the exact site and the exact reason
 * no rewrite can be offered). There is no "consider refactoring": a sentence of advice
 * with no location and no rewrite is the thing this module exists to replace. A rewrite
 * that moved the output is reported as LOCATED with the rejection as its reason — the
 * site is real, the rewrite is not shown, and the reader is never handed a wrong fix.
 *
 * WHAT "PROVEN" MEANS HERE, EXACTLY
 * ---------------------------------
 * Proven OVER THE SUPPLIED CORPUS, on every engine the grammar supports — both when it
 * compiles, the interpreted one alone when it does not — and that is stated in every
 * rendering rather than implied. A corpus that never reaches the rewritten arm proves
 * nothing about it, so the evidence carries the sample and byte counts and the caller
 * can judge. Two deliberate exclusions from the comparison:
 *
 *   - FAILURE `expected` LABELS are compared as position only, not text. A keyword
 *     rewrite changes `/\@media/` to `keyword` by design; that is diagnostic text, not
 *     parse output. Values, spans, and WHERE a parse failed are compared exactly.
 *   - The rebuild itself is not trusted, it is CHECKED: before any candidate is
 *     considered, the grammar is rebuilt with NO substitution and that identity rebuild
 *     must reproduce the corpus output exactly. If `rebuild.ts` threads any option
 *     wrongly, this check fails and NO fix is offered. Wrong makes the tool silent.
 *
 * BENEFIT IS MEASURED TOO
 * -----------------------
 * A verified-but-pointless rewrite is not offered either. Benefit is read off the same
 * analysis a CI gate reads — ungated choices, anti-patterns — plus the compiled artifact
 * size, which is deterministic and therefore safe to print. No timings: this must be
 * diffable.
 */
import type { Combinator, ParseResult, ParserDef } from '../types.ts'
import { firstSetOf } from '../combinators/first-set.ts'
import { keywords } from '../combinators/keywords.ts'
import { peek } from '../combinators/peek.ts'
import { parse } from '../combinators/grammar.ts'
import { compile } from '../table/compile.ts'
import { digestValue } from '../oracle/digest.ts'
import { analyzeGating, choiceArms, firstSetToString, peelToLeading, type GatingReport } from './gating.ts'
import { rebuildCombinator, type FrozenSubtree } from './rebuild.ts'

/** One corpus document. `name` is a label for the report; it is never a path lookup. */
export type FixSample = { name: string; text: string }

/** Stable, greppable fix class. Mirrors the `anti-pattern` kinds `diagnoseGrammar` reports. */
export type FixCode = 'keyword-regex' | 'double-not'

/** The engines a comparison ran on. `compiled` is absent when the grammar does not compile. */
export type FixEngine = 'interpreted' | 'compiled'

export type FixEvidence = {
  samples: number
  bytes: number
  engines: FixEngine[]
  /** Always true on a VERIFIED fix — the field exists so the JSON states the claim. */
  outputUnchanged: true
}

export type FixBenefit = {
  ungatedChoicesBefore: number
  ungatedChoicesAfter: number
  antiPatternsBefore: number
  antiPatternsAfter: number
  gatedChoicesBefore: number
  gatedChoicesAfter: number
  /** Bytes of `compile().source` (the table artifact module). Deterministic. `null` when the grammar does not compile. */
  artifactBytesBefore: number | null
  artifactBytesAfter: number | null
}

/** A source edit, offered only when the site is UNAMBIGUOUS in the supplied text. */
export type FixEdit = {
  path: string
  /** 1-based, for a diagnostic header. */
  line: number
  column: number
  start: number
  end: number
  oldText: string
  newText: string
  /** The whole source line the edit sits on, so a renderer can draw a real code frame. */
  lineText: string
}

export type VerifiedFix = {
  id: string
  code: FixCode
  rule: string
  armIndex: number
  /** How the site reads now, and how it would read. Rendering, not source text. */
  before: string
  after: string
  /** The arm's deep first-set before and after — the number that makes the fix self-evident. */
  armFirstSetBefore: string
  armFirstSetAfter: string
  /** The enclosing choice's gating verdict, before and after. */
  choiceId: string
  choiceGatesBefore: 'yes' | 'recoverable' | 'no'
  choiceGatesAfter: 'yes' | 'recoverable' | 'no'
  benefit: FixBenefit
  evidence: FixEvidence
  /** Present only when the site was located unambiguously in a supplied source file. */
  edit?: FixEdit
}

export type LocatedFinding = {
  id: string
  code: FixCode
  rule: string
  armIndex: number
  /** How the site reads now. */
  site: string
  /** The exact reason no rewrite can be offered. Never advice. */
  reason: string
}

export type FixReport = {
  schema: 'parseman.fix/1'
  /**
   * True when every candidate site got a verdict — i.e. the corpus was usable and the
   * identity rebuild held. FALSE IS NOT "no fixes": it means the loop could not run, and
   * an empty `verified` list under it proves nothing. Fails closed.
   */
  ok: boolean
  /** Why `ok` is false, or `null`. */
  blocked: string | null
  corpus: { samples: number; bytes: number }
  engines: FixEngine[]
  verified: VerifiedFix[]
  located: LocatedFinding[]
  /** Subtrees `rebuild.ts` reused verbatim; a candidate inside one cannot be applied. */
  frozen: FrozenSubtree[]
}

export type ProposeFixOptions = {
  /**
   * The documents the before/after comparison runs over. REQUIRED and non-empty: with no
   * corpus there is no evidence, and this module does not offer unverified rewrites.
   */
  corpus: readonly FixSample[]
  /** Grammar source, to locate edits in. Without it, fixes carry no `edit`. */
  source?: { path: string; text: string }
  /** Passed through to `analyzeGating` when measuring benefit. */
  accept?: Iterable<string>
  entryName?: string
}

// ── output comparison ────────────────────────────────────────────────────────

/**
 * One sample's output, as a comparable token.
 *
 * `OK:`/`ERR:` keeps success and failure in disjoint spaces (the identity-oracle rule),
 * and a failure compares by POSITION rather than by its `expected` labels — see the
 * module header for why that exclusion is deliberate and not a loosened oracle.
 */
function sampleToken(res: ParseResult<unknown>): string {
  return res.ok
    ? `OK:${digestValue({ value: res.value, span: res.span })}`
    : `ERR:${res.span.start}-${res.span.end}`
}

type Outputs = { interpreted: string[]; compiled: string[] | null; artifactBytes: number | null }

/**
 * THE COMPILED LEG IS THE TABLE — `compile`, which is what `compile()` means
 * at the library entry (`src/index.ts`). It used to be the source lowering, which
 * made this module a live consumer of an engine that no longer ships anything.
 *
 * `.source` still reads as a deterministic byte count on a table artifact (the
 * emitted module text), so the size half of the benefit measurement is unchanged
 * in kind — only in scale, which is why the field is no longer called
 * `codegenBytes`. Nothing here compares it across engines, only before/after
 * within one run, so the two are never mixed.
 */
function outputsOf(root: Combinator<unknown>, corpus: readonly FixSample[]): Outputs {
  const interpreted = corpus.map((s) => {
    try { return sampleToken(parse(root, s.text)) }
    catch (e) { return `THROW:${e instanceof Error ? e.name : 'unknown'}` }
  })
  let compiled: string[] | null = null
  let artifactBytes: number | null = null
  try {
    const c = compile(root)
    artifactBytes = c.source.length
    compiled = corpus.map((s) => {
      try { return sampleToken(c.parse(s.text)) }
      catch (e) { return `THROW:${e instanceof Error ? e.name : 'unknown'}` }
    })
  }
  catch { compiled = null; artifactBytes = null }
  return { interpreted, compiled, artifactBytes }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** Identical on every engine BOTH sides could run. A side that compiles and a side that
 *  stopped compiling are NOT identical — losing the compiled engine is a behaviour change. */
function sameOutputs(a: Outputs, b: Outputs): boolean {
  if (!sameList(a.interpreted, b.interpreted)) return false
  if ((a.compiled === null) !== (b.compiled === null)) return false
  if (a.compiled !== null && b.compiled !== null) return sameList(a.compiled, b.compiled)
  return true
}

// ── candidate detection ──────────────────────────────────────────────────────

/**
 * A regex that is really a fixed keyword: an optional `^`, a run of characters with no
 * regex meaning, and an optional trailing `(?![…])` word boundary.
 *
 * Deliberately NARROWER than `gating.ts`'s detector, which decides whether to REPORT.
 * This one decides whether to REWRITE, so it must recognise only shapes where
 * `keywords()` is exactly equivalent by construction, before any corpus is consulted.
 */
const EXACT_KEYWORD_RE = /^(\^?)([^\\^$*+?()[\]{}|./]+)(?:\(\?!(?:\[([^\]]*)\]|(\\[wWdDsS]))\))?$/

type KeywordRewrite = { word: string; boundary: string | undefined; caseInsensitive: boolean }

/** `null` when the regex is not provably a keyword, with the reason carried by the caller. */
function keywordRewriteOf(source: string, flags: string): KeywordRewrite | string {
  const m = EXACT_KEYWORD_RE.exec(source)
  if (m === null) return 'the pattern is not a plain keyword (it uses regex syntax beyond a literal word and a trailing (?![…]) boundary)'
  if (m[1] === '^') {
    // `regex()` compiles sticky (`y`) without `m`, so a leading `^` matches only at
    // offset 0 — this arm can only ever fire at the start of the document. That is a
    // different parser from the keyword, and worth knowing about on its own.
    return 'the pattern is `^`-anchored; under regex()\'s sticky compilation that matches only at offset 0, which keywords() does not reproduce'
  }
  const extra = flags.replace(/[iy]/g, '')
  if (extra !== '') return `the pattern carries flags /${flags}/ — only /i/ has a keywords() equivalent`
  // `(?!\w)` and `(?![\w])` are the same assertion; keywords() spells its boundary as a
  // character CLASS, so a bare escape is carried through as the class body.
  const boundary = m[3] !== undefined && m[3] !== '' ? m[3] : m[4]
  return { word: m[2]!, boundary, caseInsensitive: flags.includes('i') }
}

type Candidate = {
  id: string
  code: FixCode
  rule: string
  armIndex: number
  /** The enclosing choice's `analyzeGating` id — `rule`, or `rule#N` when the rule holds
   *  more than one choice. Resolved by NODE IDENTITY, never by re-deriving occurrence
   *  order in a second walk. */
  choiceId: string
  /** The node to replace. */
  target: Combinator<unknown>
  /** The arm the target leads, for the first-set reading. */
  arm: Combinator<unknown>
  before: string
  /** The replacement, or a reason it cannot be built. */
  replacement: Combinator<unknown> | null
  after: string | null
  reason: string | null
}

const renderRegex = (d: { source: string; flags: string }): string => `regex(/${d.source}/${d.flags.replace(/y/g, '')})`

function renderKeyword(k: KeywordRewrite): string {
  const ci = k.caseInsensitive ? ', { caseInsensitive: true }' : ''
  return k.boundary === undefined
    ? `keywords(['${k.word}']${ci === '' ? '' : `,${ci.slice(1)}`})`
    : `word('${k.word}', '${k.boundary}'${ci})`
}

/**
 * Walk every choice arm, attributing each to the CHOICE that owns it.
 *
 * The identity a reader greps — and the one `--apply` attribution reads — is the choice,
 * not the rule: `analyzeGating` already spells a rule's second choice `rule#1` precisely
 * because a rule can hold several. An id built from the rule alone collides across them,
 * and the report then sorts and renders two distinct sites as one.
 *
 * The choice id is taken from `report` by ARM-ARRAY IDENTITY rather than recomputed here.
 * `gating.ts` says out loud that a second walk drifts out of step with its `id`
 * assignment — it did, silently, and mislabelled every arm — so this does not walk twice.
 */
function collectCandidates(root: Combinator<unknown>, report: GatingReport): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<Combinator<unknown>>()
  // arms array (the choice's own `d.parsers`) → the id `analyzeGating` gave that choice.
  const idOfChoice = new Map<readonly Combinator<unknown>[], string>()
  for (const c of report.choices) {
    const arms = choiceArms(c)
    if (arms !== undefined) idOfChoice.set(arms, c.id)
  }
  const visit = (p: Combinator<unknown>, enclosing: string): void => {
    if (seen.has(p)) return
    seen.add(p)
    const d = (p as { _def?: unknown })._def as ParserDef | undefined
    if (d === undefined || typeof d !== 'object') return
    const rule = (p as { _ruleName?: string })._ruleName ?? enclosing
    if (d.tag === 'choice') {
      // A choice the report did not describe (an unanalysable one) still gets a site; it
      // falls back to the rule name, which is what the id read before choices were told
      // apart, and is unique whenever the rule holds only this one.
      const choiceId = idOfChoice.get(d.parsers) ?? rule
      d.parsers.forEach((arm, armIndex) => {
        const lead = peelToLeading(arm)
        const ld = lead._def as ParserDef
        const id = `${choiceId}#arm${armIndex}`
        if (ld.tag === 'not') {
          const inner = ld.parser
          if ((inner._def as ParserDef).tag === 'not') {
            const body = (inner._def as Extract<ParserDef, { tag: 'not' }>).parser
            out.push({
              id, code: 'double-not', rule, armIndex, choiceId, target: lead, arm,
              before: 'not(not(…))', replacement: peek(body), after: 'peek(…)', reason: null,
            })
          }
        }
        if (ld.tag === 'regex') {
          const k = keywordRewriteOf(ld.source, ld.flags)
          const before = renderRegex(ld)
          if (typeof k === 'string') {
            // Only a site `gating.ts` would REPORT is worth locating here; a general
            // regex that happens not to be a keyword is not a finding at all.
            if (/^\^?[@#.-]?[A-Za-z][\w-]*(\(\?![^)]*\))?\$?$/.test(ld.source)) {
              out.push({ id, code: 'keyword-regex', rule, armIndex, choiceId, target: lead, arm, before, replacement: null, after: null, reason: k })
            }
          }
          else {
            out.push({
              id, code: 'keyword-regex', rule, armIndex, choiceId, target: lead, arm, before,
              replacement: keywords([k.word], {
                ...(k.caseInsensitive ? { caseInsensitive: true } : {}),
                ...(k.boundary === undefined ? {} : { boundary: k.boundary }),
              }),
              after: renderKeyword(k), reason: null,
            })
          }
        }
      })
    }
    const rec = d as unknown as Record<string, unknown>
    const kids: Combinator<unknown>[] = []
    if (Array.isArray(rec.parsers)) kids.push(...(rec.parsers as Combinator<unknown>[]))
    if (Array.isArray(rec.skip)) kids.push(...(rec.skip as Combinator<unknown>[]))
    for (const k of ['parser', 'main', 'skipped', 'separator', 'sentinel', 'selector', 'otherwise', 'fallback', 'triviaParser'])
      if (rec[k]) kids.push(rec[k] as Combinator<unknown>)
    if (d.tag === 'dispatch') {
      for (const c of d.cases) kids.push(c.parser)
      if (d.matchers) for (const c of d.matchers) kids.push(c.parser)
    }
    if (d.tag === 'lazy') { try { kids.push((d as { thunk(): Combinator<unknown> }).thunk()) } catch { /* undefined ref */ } }
    for (const k of kids) visit(k, rule)
  }
  visit(root, (root as { _ruleName?: string })._ruleName ?? '<entry>')
  // Deterministic order, independent of walk order.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  return out
}

// ── source location ──────────────────────────────────────────────────────────

/**
 * Locate a candidate in the grammar source, and refuse unless it is UNAMBIGUOUS.
 *
 * A source edit is the one part of this loop the verification cannot cover: the loop
 * proves a GRAPH rewrite is output-neutral, and a text edit is only that rewrite if the
 * text really is the site. So the correspondence has to be exact — one occurrence, in
 * one spelling — and anything else declines. An edit applied to the wrong site is
 * strictly worse than no `--apply` at all.
 */
function locateEdit(
  source: { path: string; text: string },
  c: Candidate,
): FixEdit | string {
  const at = (start: number, end: number, oldText: string, newText: string): FixEdit => {
    let line = 1
    let lastNl = -1
    for (let i = 0; i < start; i++) if (source.text.charCodeAt(i) === 10) { line++; lastNl = i }
    let lineEnd = source.text.indexOf('\n', lastNl + 1)
    if (lineEnd === -1) lineEnd = source.text.length
    return {
      path: source.path, line, column: start - lastNl, start, end, oldText, newText,
      lineText: source.text.slice(lastNl + 1, lineEnd),
    }
  }
  if (c.code === 'keyword-regex') {
    const spellings = [c.before, c.before.replace(/\/\)$/, '/)')]
    const hits: number[] = []
    for (const s of new Set(spellings)) {
      let i = source.text.indexOf(s)
      while (i !== -1) { hits.push(i); i = source.text.indexOf(s, i + 1) }
    }
    if (hits.length === 0) {
      return `\`${c.before}\` does not appear literally in ${source.path}, so parseman cannot tell `
        + 'which text to change (it is probably built from a helper or a shared constant)'
    }
    if (hits.length > 1) {
      return `\`${c.before}\` appears ${hits.length} times in ${source.path}, and editing the wrong `
        + 'one would be worse than editing none'
    }
    return at(hits[0]!, hits[0]! + c.before.length, c.before, c.after!)
  }
  // double-not: find `not(not(` and balance to the outer close.
  const needle = 'not(not('
  const hits: number[] = []
  let i = source.text.indexOf(needle)
  while (i !== -1) { hits.push(i); i = source.text.indexOf(needle, i + 1) }
  if (hits.length === 0) return `\`not(not(\` does not appear literally in ${source.path}`
  if (hits.length > 1) {
    return `\`not(not(\` appears ${hits.length} times in ${source.path}, and editing the wrong one `
      + 'would be worse than editing none'
  }
  const start = hits[0]!
  // `not(not(` is the needle, so both opens are at fixed offsets. Deriving the inner one
  // with `indexOf('(')` would find a paren inside a string literal in the outer argument.
  const openOuter = start + 3
  const openInner = start + 7
  const end = matchingParen(source.text, openOuter)
  if (typeof end === 'string') return end
  const innerEnd = matchingParen(source.text, openInner)
  if (typeof innerEnd === 'string') return innerEnd
  // `not()` takes one argument, so nothing but whitespace may sit between the inner
  // close and the outer one. Anything else is a shape this rewrite does not describe.
  if (source.text.slice(innerEnd, end - 1).trim() !== '') {
    return 'something other than the inner call sits between the `not(not(` parentheses, so parseman cannot tell which text the rewrite replaces'
  }
  const whole = source.text.slice(start, end)
  const body = source.text.slice(openInner + 1, innerEnd - 1)
  return at(start, end, whole, `peek(${body})`)
}

/**
 * Index one past the `)` that closes the `(` at `open`, or the reason it cannot be found.
 *
 * A raw character scan is NOT enough here. Grammar source is full of string literals, and
 * `not(not(literal(')')))` closes a naive counter one paren early — which yields an
 * `oldText` that is not the call. `applyFixEdits` cannot catch that: its `oldText` check
 * compares against the same mis-delimited span, so it passes and writes a WRONG edit into
 * the user's file. So this skips strings, template literals, and comments.
 *
 * Regex literals are deliberately NOT lexed: telling `/` apart from division needs the
 * full expression grammar, and a regex body can hold unbalanced parens. A `/` that is not
 * a comment therefore DECLINES the site rather than risking a guess.
 */
function matchingParen(text: string, open: number): number | string {
  const AMBIGUOUS = 'a `/` inside the `not(not(` site could start a regular expression, and parseman cannot tell where the site ends without reading the whole file as JavaScript'
  const UNBALANCED = 'the parentheses after `not(not(` do not balance, so parseman cannot tell where the site ends'
  let depth = 0
  // Template-literal quasis interleave with `${…}` expressions, which are code again.
  // `inTemplate` is the stack of enclosing quasis; `braces` counts the `{` of the
  // expression frame we are in, so its closing `}` is told from a nested object literal.
  let inTemplate = 0
  let braces = 0
  const braceStack: number[] = []
  let i = open
  while (i < text.length) {
    const ch = text[i]!
    if (inTemplate > 0 && braceStack.length < inTemplate) {
      // Inside a quasi: only `\`, `` ` `` and `${` mean anything.
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { inTemplate--; i++; continue }
      if (ch === '$' && text[i + 1] === '{') { braceStack.push(braces); braces = 0; i += 2; continue }
      i++
      continue
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch
      i++
      for (;;) {
        if (i >= text.length) return UNBALANCED
        const c = text[i]!
        if (c === '\\') { i += 2; continue }
        if (c === '\n') return UNBALANCED // an unterminated string — this is not the shape we think it is
        i++
        if (c === quote) break
      }
      continue
    }
    if (ch === '`') { inTemplate++; i++; continue }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl === -1) return UNBALANCED
      i = nl + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) return UNBALANCED
      i = close + 2
      continue
    }
    if (ch === '/') return AMBIGUOUS
    if (ch === '{') { braces++; i++; continue }
    if (ch === '}') {
      if (braces === 0 && braceStack.length > 0) { braces = braceStack.pop()!; i++; continue }
      braces--
      i++
      continue
    }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') {
      depth--
      if (depth === 0) return i + 1
      i++
      continue
    }
    i++
  }
  return UNBALANCED
}

// ── the loop ─────────────────────────────────────────────────────────────────

const gatingCounts = (r: GatingReport): { ungated: number; anti: number; gated: number } =>
  ({ ungated: r.ungated.length, anti: r.antiPatterns.length, gated: r.gated })

/**
 * Propose fixes, and offer only the ones proven output-neutral over `opts.corpus`.
 *
 * Never throws: a loop that cannot run reports `ok: false` with the reason, because a
 * thrown proposal and a grammar with nothing to fix must not look the same.
 */
export function proposeFixes(root: Combinator<unknown>, opts: ProposeFixOptions): FixReport {
  const corpus = opts.corpus
  const bytes = corpus.reduce((n, s) => n + s.text.length, 0)
  const empty = (blocked: string): FixReport => ({
    schema: 'parseman.fix/1', ok: false, blocked,
    corpus: { samples: corpus.length, bytes }, engines: [],
    verified: [], located: [], frozen: [],
  })
  if (corpus.length === 0) {
    return empty('no files were given to check against. Pass --corpus <dir> pointing at some input '
      + 'your grammar parses, and parseman will apply each candidate change, rebuild the parser, and '
      + 'offer only the ones that leave your parse output exactly as it was')
  }

  const baseline = outputsOf(root, corpus)
  const engines: FixEngine[] = baseline.compiled === null ? ['interpreted'] : ['interpreted', 'compiled']

  // The rebuilder is checked before it is used: an identity rebuild must reproduce the
  // corpus output exactly, or nothing below is trustworthy and nothing is offered.
  let identity: ReturnType<typeof rebuildCombinator>
  try { identity = rebuildCombinator(root, new Map()) }
  catch (e) {
    return empty('the grammar could not be rebuilt, so no change to it could be checked — '
      + `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
  }
  if (!sameOutputs(baseline, outputsOf(identity.root, corpus))) {
    return {
      ...empty('parseman rebuilt this grammar without changing anything and got DIFFERENT parse output, '
        + 'which means its own rebuild of your grammar is not faithful. No change to it can be trusted, '
        + 'so none is offered. This is a parseman bug, not a problem with your grammar'),
      engines, frozen: identity.frozen,
    }
  }

  const before = analyzeGating(root, { ...(opts.accept === undefined ? {} : { accept: opts.accept }), ...(opts.entryName === undefined ? {} : { entryName: opts.entryName }) })
  const beforeCounts = gatingCounts(before)
  const beforeChoice = new Map(before.choices.map(c => [c.id, c]))

  const verified: VerifiedFix[] = []
  const located: LocatedFinding[] = []

  for (const c of collectCandidates(root, before)) {
    if (c.replacement === null || c.after === null) {
      located.push({ id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex, site: c.before, reason: c.reason! })
      continue
    }
    let attempt: ReturnType<typeof rebuildCombinator>
    try { attempt = rebuildCombinator(root, new Map([[c.target, c.replacement]])) }
    catch (e) {
      located.push({ id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex, site: c.before,
        reason: `applying the rewrite failed outright — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` })
      continue
    }
    if (attempt.unapplied.length > 0) {
      const frozenTag = attempt.frozen.map(f => f.tag).join(', ')
      located.push({ id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex, site: c.before,
        reason: `it sits inside a ${frozenTag}, which parseman cannot rebuild exactly. It will not `
          + 'apply a change it cannot then check, so this one is left for you' })
      continue
    }
    const after = outputsOf(attempt.root, corpus)
    if (!sameOutputs(baseline, after)) {
      // Wrong. Not shown — the site is reported, the rewrite is not.
      located.push({ id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex, site: c.before,
        reason: 'parseman tried the obvious rewrite here, and your files parsed DIFFERENTLY afterwards. '
          + 'The rewrite is therefore wrong and is not shown' })
      continue
    }
    const afterReport = analyzeGating(attempt.root, { ...(opts.accept === undefined ? {} : { accept: opts.accept }), ...(opts.entryName === undefined ? {} : { entryName: opts.entryName }) })
    const afterCounts = gatingCounts(afterReport)
    if (afterCounts.ungated >= beforeCounts.ungated && afterCounts.anti >= beforeCounts.anti) {
      located.push({ id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex, site: c.before,
        reason: 'a rewrite here is safe but pointless — it changes nothing measurable, so it is not '
          + 'worth the diff' })
      continue
    }
    // `c.choiceId` came from `beforeChoice`'s own id assignment by node identity, so this
    // is the choice the candidate actually sits in — not the rule's first one.
    const choiceId = c.choiceId
    const afterChoice = afterReport.choices.find(x => x.id === choiceId)
    const fix: VerifiedFix = {
      id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex,
      before: c.before, after: c.after,
      armFirstSetBefore: firstSetToString(firstSetOf(c.arm)),
      armFirstSetAfter: firstSetToString(firstSetOf(c.replacement)),
      choiceId,
      choiceGatesBefore: beforeChoice.get(choiceId)?.gates ?? 'no',
      choiceGatesAfter: afterChoice?.gates ?? 'no',
      benefit: {
        ungatedChoicesBefore: beforeCounts.ungated, ungatedChoicesAfter: afterCounts.ungated,
        antiPatternsBefore: beforeCounts.anti, antiPatternsAfter: afterCounts.anti,
        gatedChoicesBefore: beforeCounts.gated, gatedChoicesAfter: afterCounts.gated,
        artifactBytesBefore: baseline.artifactBytes, artifactBytesAfter: after.artifactBytes,
      },
      evidence: { samples: corpus.length, bytes, engines, outputUnchanged: true },
    }
    if (opts.source !== undefined) {
      const e = locateEdit(opts.source, c)
      if (typeof e === 'string') {
        located.push({ id: c.id, code: c.code, rule: c.rule, armIndex: c.armIndex, site: c.before,
          reason: `the change itself is proven safe, but ${e}. Make it by hand: ${c.before} → ${c.after}` })
        continue
      }
      fix.edit = e
    }
    verified.push(fix)
  }

  verified.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  located.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
  return {
    schema: 'parseman.fix/1', ok: true, blocked: null,
    corpus: { samples: corpus.length, bytes }, engines,
    verified, located, frozen: identity.frozen,
  }
}

/**
 * Apply verified edits to a source text, right-to-left so earlier offsets stay valid.
 *
 * Pure: it returns the new text and never touches the filesystem. Writing is the
 * caller's explicit second step, which is what keeps `--apply` from being something that
 * happens to you.
 */
export function applyFixEdits(sourceText: string, fixes: readonly VerifiedFix[]): { text: string; applied: number } {
  const edits = fixes.map(f => f.edit).filter((e): e is FixEdit => e !== undefined)
    .sort((a, b) => b.start - a.start)
  let text = sourceText
  let applied = 0
  for (const e of edits) {
    if (text.slice(e.start, e.end) !== e.oldText) continue // the text moved under us; skip
    text = text.slice(0, e.start) + e.newText + text.slice(e.end)
    applied++
  }
  return { text, applied }
}
