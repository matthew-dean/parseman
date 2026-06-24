/**
 * Compile a Combinator<T> definition tree into an optimized JavaScript function.
 *
 * Design: every sub-emitter uses early-return on failure. Fallible contexts
 * (optional, sepBy loops, many loops) use labeled blocks so early-exit is a
 * `break <label>` rather than an IIFE return — no function call, no result
 * object allocation per node.
 */
import type { Combinator, ParseResult, ParseError } from '../types.ts';
export type CompiledParser<T> = {
    parse(input: string, pos?: number): ParseResult<T>;
    /** Like parse(), but with a caller-supplied ParseContext (e.g. `_triviaLog` for CST grammars). */
    parseWithContext(input: string, ctx: import('../types.ts').ParseContext, pos?: number): ParseResult<T>;
    /**
     * Like parse(), but activates error recovery. recover() nodes collect their
     * ParseErrors into result.errors instead of (only) embedding them as values.
     * Always returns ParseOk — top-level failures are still ParseFail.
     */
    parseWithErrors(input: string, pos?: number): ParseResult<T> & {
        errors: ParseError[];
    };
    /** The generated source (for inspection / future source maps) */
    source: string;
    /**
     * A self-contained JS expression (IIFE) that evaluates to a parse function.
     * Safe to inline directly into transformed source — no external references
     * except for runtime-fallback parsers embedded via closures.
     * Returns null if the parser cannot be fully inlined (e.g. contains user
     * closures that can't be serialized).
     */
    inlineExpression: string | null;
};
export declare function compile<T>(parser: Combinator<T>, mapFnSources?: string[]): CompiledParser<T>;
