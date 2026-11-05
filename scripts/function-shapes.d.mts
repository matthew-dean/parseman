/** Types for `scripts/function-shapes.mjs`, which the invariant gate runs under bare `node`. */
export type AstNode = { type: string; start: number; end: number; [k: string]: unknown }
export type FunctionShape = { hash: string; chars: number; name: string; line: number }
export declare const FUNCTION: ReadonlySet<string>
export declare function isNode(v: unknown): v is AstNode
export declare function children(n: AstNode): AstNode[]
export declare function parseModule(code: string, filename: string): AstNode
export declare function functionShapes(code: string, filename: string, minChars?: number): FunctionShape[]
export declare function duplicateCount(shapes: readonly FunctionShape[]): number
