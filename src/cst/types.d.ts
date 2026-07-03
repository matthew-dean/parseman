import type { Span } from '../types.ts';
/**
 * Minimal interface a node must satisfy for incremental re-parse to navigate and
 * re-parse the tree. Any object with `_tag: 'node'`, `type`, `span`, `state`,
 * and `children` works — whether from `node()` build callbacks or custom ASTs.
 *
 * `children` only needs items with `_tag` so traversal can distinguish sub-nodes
 * from leaves. `parseDoc` uses an optional `rebuild` callback (or a
 * shallow spread) when grafting a re-parsed subtree.
 */
export type NodeLike = {
    readonly _tag: 'node';
    readonly type: string;
    readonly span: Span;
    readonly state: unknown;
    readonly children: ReadonlyArray<{
        readonly _tag: string;
    }>;
};
/**
 * A named CST node from a `node()` rule (or equivalent build callback).
 * Children are in parse order: sub-nodes interspersed with CSTLeaf terminals.
 */
export type CSTNode = {
    readonly _tag: 'node';
    /** Rule name — the method name that produced this node. */
    readonly type: string;
    readonly span: Span;
    readonly children: CSTChild[];
    /**
     * Shallow clone of ctx.state at the moment this node's parse began.
     * Used as the re-entry point for incremental re-parsing.
     * Only meaningful when ctx.state is primitives-only (no mutable objects).
     */
    readonly state: unknown;
};
/**
 * A terminal token — the result of a literal() or regex() match inside a node rule.
 */
export type CSTLeaf = {
    readonly _tag: 'leaf';
    readonly value: string;
    readonly span: Span;
};
/**
 * A record of a failed rule parse — produced when error recovery is active.
 * Carries what was successfully parsed before the failure (partial children)
 * and the expected tokens at the failure point.
 */
export type CSTError = {
    readonly _tag: 'error';
    readonly type: string;
    readonly span: Span;
    readonly expected: string[];
    readonly children: CSTChild[];
    readonly state: unknown;
};
export type CSTChild = CSTNode | CSTLeaf | CSTError;
/**
 * A trivia token — whitespace or comment consumed between terms during parsing.
 * Only present in `rawChildren`; never in the structural `children` array.
 */
export type CSTTrivia = {
    readonly _tag: 'trivia';
    readonly value: string;
    readonly span: Span;
};
/** Full child union including trivia — used in `rawChildren` from `node()` builds. */
export type CSTRawChild = CSTNode | CSTLeaf | CSTTrivia | CSTError;
