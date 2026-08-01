/**
 * Hand-written declarations for the Peggy-generated ES parser
 * `bench/json-parser.js` (regenerate the .js with `pnpm bench:compile-grammars`;
 * this .d.ts is checked in and describes Peggy's stable ES export shape).
 */
export declare const StartRules: readonly string[]

export declare class SyntaxError extends Error {
  location: { start: { offset: number; line: number; column: number }; end: { offset: number; line: number; column: number } }
  expected: readonly unknown[]
  found: string | null
}

export declare function parse(input: string, options?: { startRule?: string }): unknown
