/**
 * Chevrotain JSON parser for benchmark comparison.
 *
 * Builds the JS value directly in a single pass via `EmbeddedActionsParser` —
 * NOT a CST that a second pass then traverses. This matches what the other bench
 * parsers do (recognize + build the value), so Chevrotain isn't charged for an
 * extra CST-construction + CST→value traversal the others never perform. Same
 * JSON subset as examples/json/parser.ts. See bench/PARITY.md.
 */
import { createToken, Lexer, EmbeddedActionsParser, type IOrAlt } from 'chevrotain'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const True = createToken({ name: 'True', pattern: /true/ })
const False = createToken({ name: 'False', pattern: /false/ })
const Null = createToken({ name: 'Null', pattern: /null/ })
const LCurly = createToken({ name: 'LCurly', pattern: /{/ })
const RCurly = createToken({ name: 'RCurly', pattern: /}/ })
const LSquare = createToken({ name: 'LSquare', pattern: /\[/ })
const RSquare = createToken({ name: 'RSquare', pattern: /\]/ })
const Comma = createToken({ name: 'Comma', pattern: /,/ })
const Colon = createToken({ name: 'Colon', pattern: /:/ })
const StringLit = createToken({ name: 'StringLit', pattern: /"(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/ })
const NumberLit = createToken({ name: 'NumberLit', pattern: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/ })
const WhiteSpace = createToken({ name: 'WhiteSpace', pattern: /[ \t\n\r]+/, group: Lexer.SKIPPED })

const allTokens = [WhiteSpace, True, False, Null, LCurly, RCurly, LSquare, RSquare, Comma, Colon, StringLit, NumberLit]

const lexer = new Lexer(allTokens)

// ---------------------------------------------------------------------------
// Parser — builds the JS value directly (no CST)
// ---------------------------------------------------------------------------
class JsonParser extends EmbeddedActionsParser {
  constructor() {
    super(allTokens, { recoveryEnabled: false })
    this.performSelfAnalysis()
  }

  json = this.RULE('json', (): unknown => this.SUBRULE(this.value))

  object = this.RULE('object', (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {}
    this.CONSUME(LCurly)
    this.OPTION(() => {
      this.SUBRULE(this.objectItem, { ARGS: [obj] })
      this.MANY(() => {
        this.CONSUME(Comma)
        this.SUBRULE2(this.objectItem, { ARGS: [obj] })
      })
    })
    this.CONSUME(RCurly)
    return obj
  })

  objectItem = this.RULE('objectItem', (obj: Record<string, unknown>): void => {
    const keyImage = this.CONSUME(StringLit).image
    this.CONSUME(Colon)
    const value = this.SUBRULE(this.value)
    this.ACTION(() => { obj[JSON.parse(keyImage) as string] = value })
  })

  array = this.RULE('array', (): unknown[] => {
    const arr: unknown[] = []
    this.CONSUME(LSquare)
    this.OPTION(() => {
      const first = this.SUBRULE(this.value)
      this.ACTION(() => arr.push(first))
      this.MANY(() => {
        this.CONSUME(Comma)
        const v = this.SUBRULE2(this.value)
        this.ACTION(() => arr.push(v))
      })
    })
    this.CONSUME(RSquare)
    return arr
  })

  private cValue?: IOrAlt<unknown>[]
  value = this.RULE('value', (): unknown =>
    this.OR(this.cValue ??= [
      { ALT: () => this.SUBRULE(this.object) },
      { ALT: () => this.SUBRULE(this.array) },
      { ALT: () => { const s = this.CONSUME(StringLit).image; return this.ACTION(() => JSON.parse(s)) } },
      { ALT: () => parseFloat(this.CONSUME(NumberLit).image) },
      { ALT: () => { this.CONSUME(True); return true } },
      { ALT: () => { this.CONSUME(False); return false } },
      { ALT: () => { this.CONSUME(Null); return null } },
    ]))
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export function buildChevrotainJSON(): (input: string) => unknown {
  const parser = new JsonParser()
  return (input: string) => {
    const lexResult = lexer.tokenize(input)
    parser.input = lexResult.tokens
    const result = parser.json()
    if (parser.errors.length) throw new Error(parser.errors[0]!.message)
    return result
  }
}
