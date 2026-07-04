export type Span = {
    start: number;
    end: number;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
};
export type ParseOk<T> = {
    ok: true;
    value: T;
    span: Span;
    trivia?: Span[];
    /** Populated when parse() is called with { recover: true }. Lists all ParseErrors collected via recover() nodes. */
    errors?: ParseError[];
};
export type ParseFail = {
    ok: false;
    expected: string[];
    span: Span;
};
export type ParseResult<T> = ParseOk<T> | ParseFail;
export type ParserDef = {
    tag: 'literal';
    value: string;
    caseInsensitive: boolean;
} | {
    tag: 'regex';
    source: string;
    flags: string;
} | {
    tag: 'sequence';
    parsers: Combinator<unknown>[];
} | {
    tag: 'choice';
    parsers: Combinator<unknown>[];
    gates: (((state: unknown) => boolean) | null)[];
    disjoint: boolean;
    strategy: ChoiceStrategy;
    autoNot: (AutoNotCheck[] | null)[];
} | {
    tag: 'many';
    parser: Combinator<unknown>;
    min: 0;
} | {
    tag: 'oneOrMore';
    parser: Combinator<unknown>;
    min: 1;
} | {
    tag: 'optional';
    parser: Combinator<unknown>;
} | {
    tag: 'sepBy';
    parser: Combinator<unknown>;
    separator: Combinator<unknown>;
} | {
    tag: 'transform';
    parser: Combinator<unknown>;
    fn: (v: unknown, span: {
        start: number;
        end: number;
    }) => unknown;
} | {
    tag: 'skip';
    main: Combinator<unknown>;
    skipped: Combinator<unknown>;
} | {
    tag: 'trivia';
    parser: Combinator<unknown>;
} | {
    tag: 'grammar';
    parser: Combinator<unknown>;
    triviaParser: Combinator<unknown> | undefined;
    trackLines: boolean;
} | {
    tag: 'lazy';
    thunk: () => Combinator<unknown>;
} | {
    tag: 'guard';
    predicate: (state: unknown) => boolean;
} | {
    tag: 'withCtx';
    extra: unknown;
    parser: Combinator<unknown>;
} | {
    tag: 'recover';
    parser: Combinator<unknown>;
    sentinel: Combinator<unknown>;
} | {
    tag: 'scanTo';
    sentinel: Combinator<unknown>;
    skip: Combinator<unknown>[];
    orEOF: boolean;
} | {
    tag: 'unknown';
};
export type Combinator<T> = {
    readonly _tag: string;
    readonly _meta: ParserMeta;
    readonly _def: ParserDef;
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T>;
};
export type ParseContext = {
    trivia?: Combinator<unknown>;
    trackLines: boolean;
    /** Grammar-author-provided state, scoped with withCtx() and read in guard(). */
    state?: unknown;
    /** When set, recover() nodes push their ParseError here instead of (only) embedding it in the tree. */
    _errors?: ParseError[];
    /**
     * When set by completionsAt(), tracks the highest-position ParseFail seen
     * during parsing up to _probe.offset. Used to return completions at the cursor
     * even when sepBy/many backtracked past the cursor position.
     */
    _probe?: {
        offset: number;
        best: ParseFail | null;
    };
    /**
     * Framework-internal: current CSTNode rule's child collector.
     * Set by GrammarParser capital-letter parser; undefined outside CST parsing.
     * CSTNode parsers append themselves here after a successful parse.
     */
    _cstChildren?: unknown[];
    /**
     * Framework-internal: collector for CSTLeaf terminals.
     * Usually points to the same array as _cstChildren (both live together).
     * literal() and regex() append a CSTLeaf here when set.
     */
    _cstLeaves?: unknown[];
    /**
     * Framework-internal: collector for ALL children including trivia.
     * Set alongside _cstChildren/_cstLeaves. Receives CSTLeaf + CSTNode entries
     * (same as _cstChildren) PLUS CSTTrivia entries for trivia consumed between terms.
     * Passed to buildNode() as rawChildren so grammars can inspect trivia.
     */
    _cstRawChildren?: unknown[];
};
/**
 * Sentinel value returned by recover() when its inner parser fails.
 * The span covers the skipped input; expected lists what the inner parser wanted.
 */
export type ParseError = {
    readonly _tag: 'parseError';
    readonly span: Span;
    readonly expected: string[];
};
export type ParserMeta = {
    /** Character codes / ranges that can start this parser (for choice dispatch) */
    firstSet: FirstSet;
    /** Whether this parser can consume a newline character */
    canMatchNewline: boolean;
    /** Whether this parser is marked as trivia (auto-skip) */
    isTrivia: boolean;
    /** choice(): true when all alternative first sets are pairwise disjoint */
    disjoint?: boolean;
};
/** A first set is either "any" (unknown/unbounded) or a list of char code ranges */
export type FirstSet = {
    kind: 'any';
} | {
    kind: 'ranges';
    ranges: CharRange[];
} | {
    kind: 'empty';
};
export type CharRange = {
    lo: number;
    hi: number;
};
/**
 * Determines how a non-disjoint choice dispatches at runtime/compile-time.
 *
 * greedyClassify: one regex arm subsumes all literal arms — run the regex once,
 *                 classify the result with string equality. Single parse call, no backtracking.
 * literalsLongestFirst: all arms are literals — try from longest to shortest, no regex,
 *                       no ambiguity, no backtracking.
 * firstMatch: PEG fallback — try each arm in order; arms with autoNot[] get an inline
 *             rejection check so a later arm can "win" without explicit not().
 */
export type ChoiceStrategy = {
    tag: 'greedyClassify';
    superIndex: number;
} | {
    tag: 'literalsLongestFirst';
    sortedIndices: number[];
} | {
    tag: 'firstMatch';
};
/**
 * Used only by the 'firstMatch' fallback strategy. Describes what char/string at
 * the END of an arm's match should cause that arm to be rejected so the next arm
 * is tried. Auto-derived from sibling alternatives at construction time.
 */
export type AutoNotCheck = {
    kind: 'firstSet';
    set: FirstSet;
} | {
    kind: 'startsWith';
    value: string;
};
/**
 * A choice arm with an optional gate predicate. When a gate is provided,
 * it is evaluated (cheaply, without parsing) before the arm is attempted.
 * If the gate returns false the arm is skipped entirely.
 *
 * Usage: choice({ gate: s => (s as Ctx).inFn, combinator: returnKw }, ident)
 */
export type GatedArm<T = unknown> = {
    gate: (state: unknown) => boolean;
    combinator: Combinator<T>;
};
