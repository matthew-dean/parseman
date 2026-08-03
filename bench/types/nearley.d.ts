/**
 * Minimal hand-written declarations for `nearley`, which ships no types and has
 * no `@types/nearley` in this workspace. Covers exactly the surface
 * `bench/nearley-parse.ts` uses — the compiled-grammar loader and the streaming
 * Parser — rather than the whole library.
 */
declare module 'nearley' {
  /** A grammar module produced by `nearleyc` (`bench/*-nearley.cjs`). */
  export type CompiledRules = {
    ParserRules: readonly unknown[]
    ParserStart: string
    Lexer?: unknown
  }

  export class Grammar {
    static fromCompiled(rules: CompiledRules): Grammar
  }

  export class Parser {
    constructor(grammar: Grammar, options?: { keepHistory?: boolean })
    results: unknown[]
    feed(chunk: string): this
    finish(): unknown[]
  }

  const nearley: { Grammar: typeof Grammar; Parser: typeof Parser }
  export default nearley
}
