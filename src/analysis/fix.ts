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
 * Proven OVER THE SUPPLIED CORPUS, on both engines, and that is stated in every
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
import { compile } from '../compiler/codegen.ts'
import { digestValue } from '../oracle/digest.ts'
import { analyzeGating, firstSetToString, peelToLeading, type GatingReport } from './gating.ts'
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
  /** Bytes of `compile().source`. Deterministic. `null` when the grammar does not compile. */
  codegenBytesBefore: number | null
  codegenBytesAfter: number | null
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

type Outputs = { interpreted: string[]; compiled: string[] | null; codegenBytes: number | null }

function outputsOf(root: Combinator<unknown>, corpus: readonly FixSample[]): Outputs {
  const interpreted = corpus.map((s) => {
    try { return sampleToken(parse(root, s.text)) }
    catch (e) { return `THROW:${e instanceof Error ? e.name : 'unknown'}` }
  })
  let compiled: string[] | null = null
  let codegenBytes: number | null = null
  try {
    const c = compile(root)
    codegenBytes = c.source.length
    compiled = corpus.map((s) => {
      try { return sampleToken(c.parse(s.text)) }
      catch (e) { return `THROW:${e instanceof Error ? e.name : 'unknown'}` }
    })
  }
  catch { compiled = null; codegenBytes = null }
  return { interpreted, compiled, codegenBytes }
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

/** Walk every choice arm, attributing each to the rule that owns it — the same walk shape
 *  `analyzeGatingRules` uses, so ids read `rule#armN` exactly as the diagnosis does. */
function collectCandidates(root: Combinator<unknown>): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<Combinator<unknown>>()
  const visit = (p: Combinator<unknown>, enclosing: string): void => {
    if (seen.has(p)) return
    seen.add(p)
    const d = (p as { _def?: unknown })._def as ParserDef | undefined
    if (d === undefined || typeof d !== 'object') return
    const rule = (p as { _ruleName?: string })._ruleName ?? enclosing
    if (d.tag === 'choice') {
      d.parsers.forEach((arm, armIndex) => {
        const lead = peelToLeading(arm)
        const ld = lead._def as ParserDef
        const id = `${rule}#arm${armIndex}`
        if (ld.tag === 'not') {
          const inner = ld.parser
          if ((inner._def as ParserDef).tag === 'not') {
            const body = (inner._def as Extract<ParserDef, { tag: 'not' }>).parser
            out.push({
              id, code: 'double-not', rule, armIndex, target: lead, arm,
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
              out.push({ id, code: 'keyword-regex', rule, armIndex, target: lead, arm, before, replacement: null, after: null, reason: k })
            }
          }
          else {
            out.push({
              id, code: 'keyword-regex', rule, armIndex, target: lead, arm, before,
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
 * strictly worse than no `--fix` at all.
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
  const openOuter = start + 3
  let depth = 0
  let end = -1
  for (let j = openOuter; j < source.text.length; j++) {
    const ch = source.text[j]
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  if (end === -1) return 'the parentheses after `not(not(` do not balance, so parseman cannot tell where the site ends'
  const whole = source.text.slice(start, end)
  const innerOpen = source.text.indexOf('(', openOuter + 1)
  const body = source.text.slice(innerOpen + 1, end - 2)
  return at(start, end, whole, `peek(${body})`)
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

  for (const c of collectCandidates(root)) {
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
    const choiceId = beforeChoice.has(c.rule) ? c.rule : [...beforeChoice.keys()].find(k => k.startsWith(`${c.rule}#`)) ?? c.rule
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
        codegenBytesBefore: baseline.codegenBytes, codegenBytesAfter: after.codegenBytes,
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
 * caller's explicit second step, which is what keeps `--fix` from being something that
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
