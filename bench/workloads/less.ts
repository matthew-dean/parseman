/**
 * A Less-dialect stylesheet grammar, vendored.
 *
 * ## Why this file exists at all
 *
 * The three parse regressions parseman shipped in 0.34.0 and 0.35.0 were all
 * found by a downstream project's Less grammar and by nothing in this repo. The
 * obvious fix — measure that grammar — is not available: reaching into a sibling
 * checkout makes the gate unrunnable for a contributor who has only cloned
 * parseman, and a previous attempt was rejected for exactly that. So the grammar
 * is vendored, in the same spirit as `examples/css/parser.ts`, which is already
 * an adaptation of the same downstream project's CSS grammar.
 *
 * ## What "realistic" has to mean here
 *
 * Not "long". A grammar catches compiler regressions in proportion to how much
 * of the compiler it exercises, and the three axes that have actually bitten are:
 *
 *   1. SPECULATIVE ROLLBACK per byte — `not`, `attempt`, losing `choice` arms,
 *      failing `many`/`sepBy` items. 0.34.0's unconditional capture-buffer
 *      truncations rode this.
 *   2. DERIVED EXPECTED-SET WIDTH — how many tokens `deriveExpected` reaches
 *      through nullable prefixes, and how often a losing choice concatenates
 *      those sets. 0.35.0's `fix(expect)` rode this, and the rollback sweep read
 *      flat on it.
 *   3. Everything nobody has thought of yet.
 *
 * (1) and (2) are not decorations bolted on to hit a number; they are what a
 * Less grammar unavoidably is. Less's statement position is genuinely ambiguous
 * — `.mixin()` is a call, a definition, or a selector; `a:hover {` and
 * `color: red;` share a prefix through the colon — so a Less parser attempts and
 * rolls back constantly, and every one of those rollbacks that loses a choice
 * builds an expected set. This grammar reproduces that ambiguity rather than
 * simulating its cost, which is why it catches (3) too.
 *
 * Calibrated against the real events rather than against a density target.
 * Replaying `fix(not)`, this grammar reads +37% to +44% where jess's Less grammar
 * measured +33.9% and the CSS workload beside it reads flat — the same sign,
 * magnitude and ORDERING as the real regression. Replaying `fix(expect)` it reads
 * +2% to +9% where jess's measured +49.6%: real, detected, and much weaker. That
 * second number is the honest limit of this file and is documented as such in
 * `docs/design/perf-gates.md`.
 *
 * ## What it is NOT
 *
 * It is not a conformant Less parser, and no test asserts that it is. It builds
 * a CST and reports spans; it does not evaluate, and it does not reject much.
 * Its contract is narrow and stated here: it must exercise the compiler the way
 * a real stylesheet grammar does. If a future parseman change makes THIS parse
 * wrong, the gate's `assertSameParse` fails loudly rather than silently timing
 * two different parses.
 */
import {
  node, regex, literal, sequence, choice, many, oneOrMore, optional, not, attempt,
  parser, trivia, rules,
  type Combinator,
} from '../../src/index.ts'
import { mk } from './shared.ts'

const ws = regex(/[ \t\n\r\f]+/)
const lineComment = regex(/\/\/[^\n]*/)
const blockComment = regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)
const rw = trivia(oneOrMore(choice(ws, lineComment, blockComment)))

const ident = regex(/-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const atName = regex(/@@?-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const propName = regex(/-?[_a-zA-Z*\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const customProp = regex(/--[-_a-zA-Z0-9\u0080-\uffff]*/)
const numPart = regex(/\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?/)
const unitPart = regex(/%|-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const colorHex = regex(/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/)
const singleStr = regex(/'(?:[^'\\]|\\.)*'/)
const doubleStr = regex(/"(?:[^"\\]|\\.)*"/)
const classOrId = regex(/[.#]-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*/)
const elementSel = regex(/-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*|\*/)
const combinator = regex(/>>>|\|\||[>+~]/)
const pseudoColon = regex(/::?/)
const attrOp = regex(/[*~|^$]?=/)
const nthArg = regex(/even|odd|[-+]?\d*n(?:[ \t\n\r\f]*[+-][ \t\n\r\f]*\d+)?|[-+]?\d+/i)
const mathOp = regex(/[*/]|[-+](?=[ \t\n\r\f])/)
const compareOp = regex(/[<>]=?|=<|=/)
const logicalOp = regex(/and|or|not/)
const unarySign = regex(/[-+](?=[.\d@(])/)
const urlBody = regex(/[^)"'\s]*/)
const escapedBody = regex(/`(?:[^`\\]|\\.)*`/)

/**
 * The value loop's terminator set, as negative lookaheads.
 *
 * A stylesheet value is "everything up to one of these", and every dialect's
 * grammar has to say so somewhere. Saying it as `not()` in front of the term —
 * rather than as a scan — is what a combinator grammar does, and it is why real
 * stylesheet grammars execute `not()` hundreds of times per KB while this repo's
 * microbenchmarks execute it about twenty times.
 */
const valueStop = (): Array<Combinator<unknown>> => [
  not(literal(';')),
  not(literal('}')),
  not(literal('{')),
  not(literal(')')),
  not(literal('!')),
]

/** The same idea one level down: a comma-separated argument stops earlier. */
const argStop = (): Array<Combinator<unknown>> => [
  not(literal(')')),
  not(literal(';')),
  not(literal(',')),
]

/** The whole rule map — see the note on `cssRules` in examples/css/parser.ts.
 *  Analysis names choice sites by rule, so it needs the map, not the entry rule. */
export const lessRules = rules((g: {
  Stylesheet: Combinator<unknown>
  statement: Combinator<unknown>
  block: Combinator<unknown>
  AtRuleBlock: Combinator<unknown>
  AtRuleStatement: Combinator<unknown>
  VariableDecl: Combinator<unknown>
  MixinDefinition: Combinator<unknown>
  MixinCall: Combinator<unknown>
  Ruleset: Combinator<unknown>
  Declaration: Combinator<unknown>
  CustomDeclaration: Combinator<unknown>
  Guard: Combinator<unknown>
  guardTerm: Combinator<unknown>
  paramList: Combinator<unknown>
  Param: Combinator<unknown>
  argList: Combinator<unknown>
  SelectorList: Combinator<unknown>
  ComplexSelector: Combinator<unknown>
  CompoundSelector: Combinator<unknown>
  simpleSelector: Combinator<unknown>
  AttributeSelector: Combinator<unknown>
  PseudoSelector: Combinator<unknown>
  pseudoArg: Combinator<unknown>
  Interpolation: Combinator<unknown>
  valueList: Combinator<unknown>
  Expression: Combinator<unknown>
  operand: Combinator<unknown>
  term: Combinator<unknown>
  Keyword: Combinator<unknown>
}) => {
  const N = (type: string, body: Combinator<unknown>): Combinator<unknown> =>
    node(type, body, (c, _f, s, raw, tl) => mk(type, c, raw, s, tl))

  const P = (body: Combinator<unknown>): Combinator<unknown> => parser({ trivia: rw }, body)

  // ── statements ────────────────────────────────────────────────────────────
  //
  // This choice is the grammar's centre of gravity and the reason a Less parser
  // backtracks the way it does. `.button` opens a ruleset, a mixin definition or
  // a mixin call and nothing shorter than the whole construct distinguishes
  // them; `a:hover` and `color:red` share a prefix through the colon. Every arm
  // that loses here contributes its expected set to the enclosing concat, which
  // is the shape `fix(expect)` made quadratic.

  const Stylesheet = N('Stylesheet', P(many(g.statement)))

  // Grouped INLINE by what the statement starts with, not flattened into nine
  // independent rules. `@`-led and selector-led statements each share a prefix
  // and are distinguished only by what comes after it, so a grammar that names
  // them as one decision each is saying something true about the language — and
  // it is also what lets the enclosing choice see the real width of what it just
  // failed to match, instead of one narrow set per rule boundary.
  const statement = choice(
    choice(g.VariableDecl, g.AtRuleBlock, g.AtRuleStatement),
    choice(g.MixinDefinition, g.MixinCall, g.Ruleset),
    choice(g.CustomDeclaration, g.Declaration),
    literal(';'),
  )

  const block = P(sequence(literal('{'), many(g.statement), literal('}')))

  // ── at-rules and variables ────────────────────────────────────────────────
  //
  // `@media` and `@x: 1px` share their first token, so the variable arm has to
  // be attempted and rolled back on every at-rule in the file.

  const VariableDecl = N('VariableDecl', attempt(P(sequence(
    atName,
    literal(':'),
    g.valueList,
    optional(sequence(literal('!'), ident)),
    literal(';'),
  ))))

  const atPrelude = many(sequence(
    not(literal('{')),
    not(literal(';')),
    choice(g.Interpolation, g.term, ident, regex(/[^{};]/)),
  ))

  const AtRuleBlock = N('AtRuleBlock', P(sequence(atName, optional(atPrelude), g.block)))
  const AtRuleStatement = N('AtRuleStatement', attempt(P(sequence(atName, optional(atPrelude), literal(';')))))

  // ── mixins ────────────────────────────────────────────────────────────────

  const MixinDefinition = N('MixinDefinition', attempt(P(sequence(
    oneOrMore(sequence(optional(combinator), classOrId)),
    literal('('),
    optional(g.paramList),
    literal(')'),
    optional(g.Guard),
    g.block,
  ))))

  const Param = N('Param', P(sequence(
    optional(literal('@rest')),
    choice(
      sequence(atName, optional(sequence(choice(literal(':'), literal('...')), optional(g.Expression)))),
      g.Expression,
    ),
  )))

  const paramList = P(sequence(g.Param, many(sequence(choice(literal(','), literal(';')), g.Param))))

  const MixinCall = N('MixinCall', attempt(P(sequence(
    oneOrMore(sequence(optional(combinator), classOrId)),
    optional(sequence(literal('('), optional(g.argList), literal(')'))),
    optional(sequence(literal('!'), ident)),
    literal(';'),
  ))))

  const argList = P(sequence(
    P(sequence(...argStop(), g.valueList)),
    many(sequence(choice(literal(','), literal(';')), P(sequence(...argStop(), g.valueList)))),
  ))

  // Guards are the other genuinely-nullable prefix in Less: `when` is followed
  // by an optional `not`, and each term is an optional-parenthesised comparison.
  const Guard = N('Guard', P(sequence(
    literal('when'),
    optional(logicalOp),
    g.guardTerm,
    many(sequence(choice(literal(','), logicalOp), g.guardTerm)),
  )))

  const guardTerm = P(choice(
    sequence(literal('('), g.Expression, optional(sequence(compareOp, g.Expression)), literal(')')),
    sequence(optional(literal('not')), literal('('), g.Expression, literal(')')),
    g.Expression,
  ))

  // ── rulesets and declarations ─────────────────────────────────────────────

  const Ruleset = N('Ruleset', P(sequence(g.SelectorList, optional(g.Guard), g.block)))

  const SelectorList = P(sequence(g.ComplexSelector, many(sequence(literal(','), g.ComplexSelector))))
  // A nested selector may LEAD with a combinator (`+ .btn-block { … }`), which is
  // one more nullable prefix in front of an already-ambiguous position.
  const ComplexSelector = N('ComplexSelector', P(sequence(
    optional(combinator),
    g.CompoundSelector,
    many(sequence(optional(combinator), g.CompoundSelector)),
  )))
  const CompoundSelector = N('CompoundSelector', P(oneOrMore(sequence(
    not(literal('{')),
    not(literal(',')),
    not(literal('}')),
    g.simpleSelector,
  ))))
  const simpleSelector = choice(
    g.AttributeSelector,
    g.PseudoSelector,
    g.Interpolation,
    literal('&'),
    classOrId,
    elementSel,
    // A bare sigil, so `.@{prefix}-alert` composes as sigil + interpolation +
    // element rather than needing its own rule. Reachable only after classOrId
    // has already failed, which is itself a rollback on every ordinary class.
    regex(/[.#]/),
  )

  const AttributeSelector = N('AttributeSelector', P(sequence(
    literal('['), choice(g.Interpolation, ident),
    optional(sequence(attrOp, choice(singleStr, doubleStr, ident))),
    literal(']'),
  )))
  const PseudoSelector = N('PseudoSelector', P(sequence(
    pseudoColon, ident,
    optional(sequence(literal('('), g.pseudoArg, literal(')'))),
  )))
  const pseudoArg = P(choice(nthArg, g.SelectorList, g.Expression))

  const Interpolation = N('Interpolation', sequence(regex(/[@$]\{/), ident, literal('}')))

  // `attempt` here is not decoration: `a:hover {` enters this rule, consumes
  // `a`, `:`, then a value list, and only fails at the `{`. Every selector in
  // the file pays one full speculative declaration parse.
  const Declaration = N('Declaration', attempt(P(sequence(
    choice(g.Interpolation, propName),
    many(choice(g.Interpolation, propName)),
    literal(':'),
    g.valueList,
    optional(sequence(literal('!'), ident)),
    choice(literal(';'), literal('}')),
  ))))

  const CustomDeclaration = N('CustomDeclaration', attempt(P(sequence(
    customProp,
    literal(':'),
    many(sequence(not(literal(';')), not(literal('}')), regex(/[^;}]/))),
    literal(';'),
  ))))

  // ── values ────────────────────────────────────────────────────────────────
  //
  // The value grammar is written INLINE — nested `choice`es with nullable
  // prefixes, not one rule reference per node type. That is how a stylesheet
  // value grammar is actually written, because the alternatives are not
  // independently reusable productions: "a term is a number or a colour or a
  // call or a word" is one decision, not eleven rules.
  //
  // It also happens to be the shape a derived-expected-set regression rides.
  // A choice that loses EVERY arm concatenates its arms' expected sets, and when
  // that choice is itself an arm of an enclosing choice the concatenated array
  // becomes the enclosing one's arm snapshot — so width COMPOUNDS up the nesting
  // instead of adding. Behind a rule reference it does not compound at all: the
  // reference is a function boundary and the enclosing choice sees one narrow
  // set. The first draft of this file routed every alternative through `g.*` and
  // read FLAT on the `fix(expect)` replay while jess's Less grammar, which does
  // not, read +49.6%. Same axis, same dialect, opposite answer — from nothing but
  // where the rule boundaries were drawn. `bench/workloads/fxprobe.ts` measures
  // that exposure; re-run it when this grammar changes.
  //
  // Recorded because it is the sharpest lesson in this directory: a workload can
  // be realistic in its vocabulary and still be structurally unable to see the
  // thing it was built to see. `bench/workloads/fxprobe.ts` measures the
  // exposure, and it should be re-run when this grammar changes.

  const valueList = P(sequence(g.Expression, many(sequence(literal(','), g.Expression))))

  const Expression = N('Expression', P(oneOrMore(sequence(...valueStop(), g.operand))))

  // `optional(mathOp)` between terms: `2px 4px` and `2px + 4px` are both valid,
  // so the operator position is nullable and the derivation reaches the whole
  // term alphabet through it from every term.
  const operand = P(sequence(g.term, many(sequence(optional(mathOp), g.term))))

  // The leaf alphabet, layered the way Less layers it: value \u2192 expression \u2192
  // operand \u2192 term \u2192 entity \u2192 literal/reference/group. Each layer is a `choice`
  // whose arms are the layer below, and each is written inline.
  //
  // The layering is what the language is — `2px` is a dimension is a numeric
  // literal is an entity is a term — and it is also what makes the value position
  // the most exposed point in the grammar. At a value terminator EVERY layer
  // fails at once, and each layer's concatenated expected set becomes an arm
  // snapshot for the layer above it, so width compounds instead of adding. That
  // is exactly the shape `fix(expect)` turned quadratic, and a value terminator
  // is reached once per operand — thousands of times in a 50 KB stylesheet.

  const numericLiteral = choice(
    N('Dimension', sequence(numPart, unitPart)),
    N('Num', sequence(numPart, not(regex(/[a-zA-Z%\u0080-\uffff]/)))),
    N('Color', colorHex),
    N('UnicodeRange', regex(/[uU]\+[0-9a-fA-F?]{1,6}(?:-[0-9a-fA-F]{1,6})?/)),
  )

  const textLiteral = choice(
    N('Escaped', choice(sequence(literal('~'), choice(singleStr, doubleStr)), escapedBody)),
    N('Quoted', sequence(optional(literal('~')), choice(singleStr, doubleStr))),
    N('Url', P(sequence(regex(/url\(/i), optional(choice(singleStr, doubleStr, urlBody)), literal(')')))),
    N('Progid', regex(/progid:[-.\w]+/i)),
  )

  const referenceEntity = choice(
    N('Variable', sequence(atName, optional(sequence(literal('['), optional(ident), literal(']'))))),
    g.Interpolation,
    N('Call', P(sequence(choice(g.Interpolation, ident), literal('('), optional(g.argList), literal(')')))),
    N('PropRef', sequence(literal('$'), ident)),
  )

  const groupEntity = choice(
    N('Paren', P(sequence(literal('('), optional(g.valueList), literal(')')))),
    N('DetachedRuleset', g.block),
  )

  /**
   * The arithmetic prefix, in front of every arm that can take part in
   * arithmetic — numbers, variables and parenthesised groups, but not strings or
   * bare keywords.
   *
   * `margin: @gutter / -2` and `width: (@a * -1)` are ordinary Less, so the
   * position genuinely admits an operator and then a sign, both optional, over
   * overlapping alphabets. Writing it per-arm rather than once outside the choice
   * is what the language requires: only some alternatives are operands.
   *
   * It is also the exact structure a derived-expected-set regression needs to be
   * visible. Deriving through a nullable prefix re-reaches the tokens behind it
   * from every arm that shares it, so a shared prefix is what turns a widened
   * derivation into a wider CONCAT — and arms whose prefixes are disjoint have
   * nothing to re-reach. An earlier draft of this file put `optional(mathOp)`
   * outside the choice, in the operand loop. Same operators, same input, same
   * parse — and the `fix(expect)` replay read +0.5% instead of the +2%…+9% it
   * reads now, because outside the choice there is no arm to re-reach it from.
   */
  const arith = (tail: Combinator<unknown>): Combinator<unknown> =>
    sequence(optional(mathOp), optional(unarySign), tail)

  // The value choice, FLAT: every operand alternative carries the arithmetic
  // prefix itself. Written this way because only some alternatives are operands —
  // a string cannot be negated — so the prefix cannot be hoisted out of the
  // choice without saying something false about the language.
  const entity = choice(
    arith(numericLiteral),
    arith(referenceEntity),
    arith(groupEntity),
    textLiteral,
  )

  const term = choice(entity, g.Keyword)

  // The catch-all arm, and the reason the value choice is UNGATED: a bare word in
  // a stylesheet value can start with almost any character, so no first-char
  // dispatch can reject this position cheaply. Real stylesheet grammars all have
  // this arm, and a gated choice never pays the expected-set concat at all —
  // which is the second half of why the first draft read flat.
  const Keyword = N('Keyword', sequence(
    not(literal('when')),
    choice(g.Interpolation, ident, regex(/[^\s;{}()[\],!]+/)),
  ))

  return {
    Stylesheet, statement, block,
    AtRuleBlock, AtRuleStatement, VariableDecl,
    MixinDefinition, MixinCall, Ruleset, Declaration, CustomDeclaration,
    Guard, guardTerm, paramList, Param, argList,
    SelectorList, ComplexSelector, CompoundSelector, simpleSelector,
    AttributeSelector, PseudoSelector, pseudoArg, Interpolation,
    valueList, Expression, operand, term, Keyword,
  }
})

export const { Stylesheet } = lessRules
