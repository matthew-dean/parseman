/**
 * Chevrotain JSON parser that builds a CST, for the "JSON CST — syntax tree
 * building" comparison chart only. This is Chevrotain's `CstParser` path
 * (recognize → CST → traverse to a value). The plain value-parsing chart uses the
 * single-pass `EmbeddedActionsParser` in bench/chevrotain-json.ts instead — see
 * bench/PARITY.md. Same JSON subset as examples/json/parser.ts.
 */
import {
  createToken, Lexer, CstParser, tokenMatcher,
  type IToken, type CstNode,
} from 'chevrotain'

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
// Combinator
// ---------------------------------------------------------------------------
class JsonParser extends CstParser {
  constructor() {
    super(allTokens)
    this.performSelfAnalysis()
  }

  json = this.RULE('json', () => {
    this.SUBRULE(this.value)
  })

  object = this.RULE('object', () => {
    this.CONSUME(LCurly)
    this.OPTION(() => {
      this.SUBRULE(this.objectItem)
      this.MANY(() => {
        this.CONSUME(Comma)
        this.SUBRULE2(this.objectItem)
      })
    })
    this.CONSUME(RCurly)
  })

  objectItem = this.RULE('objectItem', () => {
    this.CONSUME(StringLit)
    this.CONSUME(Colon)
    this.SUBRULE(this.value)
  })

  array = this.RULE('array', () => {
    this.CONSUME(LSquare)
    this.OPTION(() => {
      this.SUBRULE(this.value)
      this.MANY(() => {
        this.CONSUME(Comma)
        this.SUBRULE2(this.value)
      })
    })
    this.CONSUME(RSquare)
  })

  value = this.RULE('value', () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.object) },
      { ALT: () => this.SUBRULE(this.array) },
      { ALT: () => this.CONSUME(StringLit) },
      { ALT: () => this.CONSUME(NumberLit) },
      { ALT: () => this.CONSUME(True) },
      { ALT: () => this.CONSUME(False) },
      { ALT: () => this.CONSUME(Null) },
    ])
  })
}

// ---------------------------------------------------------------------------
// Visitor (CST → JS value)
// ---------------------------------------------------------------------------
function cstToValue(node: CstNode | IToken): unknown {
  if ('image' in node) {
    // IToken
    if (tokenMatcher(node, StringLit)) return JSON.parse(node.image)
    if (tokenMatcher(node, NumberLit)) return parseFloat(node.image)
    if (tokenMatcher(node, True)) return true
    if (tokenMatcher(node, False)) return false
    if (tokenMatcher(node, Null)) return null
    return node.image
  }
  // CstNode
  const n = node as CstNode
  if (n.name === 'json') return cstToValue((n.children['value']![0]) as CstNode)
  if (n.name === 'value') {
    const child = Object.values(n.children).flat()[0]
    if (child) return cstToValue(child as CstNode | IToken)
    return null
  }
  if (n.name === 'object') {
    const items = (n.children['objectItem'] ?? []) as CstNode[]
    const obj: Record<string, unknown> = {}
    for (const item of items) {
      const key = JSON.parse((item.children['StringLit']![0] as IToken).image)
      const val = cstToValue(item.children['value']![0] as CstNode)
      obj[key] = val
    }
    return obj
  }
  if (n.name === 'array') {
    const values = (n.children['value'] ?? []) as CstNode[]
    return values.map(v => cstToValue(v))
  }
  if (n.name === 'objectItem') {
    return null // handled above
  }
  return null
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
export function buildChevrotainCSTJSON(): (input: string) => unknown {
  const parser = new JsonParser()
  return (input: string) => {
    const lexResult = lexer.tokenize(input)
    parser.input = lexResult.tokens
    const cst = parser.json()
    return cstToValue(cst)
  }
}
