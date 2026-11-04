/**
 * Expression language parser — demonstrates AST construction with parseman.
 *
 * Parser (informal):
 *   expr     = if_expr | or_expr
 *   or_expr  = and_expr ('||' and_expr)*
 *   and_expr = eq_expr  ('&&' eq_expr)*
 *   eq_expr  = cmp_expr (('==' | '!=') cmp_expr)*
 *   cmp_expr = add_expr (('<=' | '>=' | '<' | '>') add_expr)*
 *   add_expr = mul_expr (('+' | '-') mul_expr)*
 *   mul_expr = unary   (('*' | '/') unary)*
 *   unary    = ('-' | '!') unary | call
 *   call     = atom ('(' args ')')?
 *   atom     = number | bool | ident | '(' expr ')'
 *   if_expr  = 'if' expr 'then' expr 'else' expr
 */
import {
  literal, regex, sequence, choice, many, optional, sepBy,
  transform, rules, parser, trivia,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import type { Expr, BinaryExpr } from './ast.ts'
import { NumberNode, BoolNode, IdentNode, BinaryNode, UnaryNode, CallNode, IfNode } from './lang-node.js'
// Re-exported so a printed copy of this grammar can bind the names its reducers call.
export { NumberNode, BoolNode, IdentNode, BinaryNode, UnaryNode, CallNode, IfNode } from './lang-node.js'

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const ws = trivia(regex(/\s*/))

const number: Combinator<Expr> = transform(
  regex(/-?[0-9]+(?:\.[0-9]+)?/),
  (s, span): Expr => new NumberNode(parseFloat(s), span)
)

const boolTrue: Combinator<Expr> = transform(
  regex(/true(?!\w)/),
  (_, span): Expr => new BoolNode(true, span)
)

const boolFalse: Combinator<Expr> = transform(
  regex(/false(?!\w)/),
  (_, span): Expr => new BoolNode(false, span)
)

const ident: Combinator<Expr> = transform(
  regex(/[a-zA-Z_]\w*/),
  (name, span): Expr => new IdentNode(name, span)
)

// ---------------------------------------------------------------------------
// Expression grammar (recursive via parser())
// ---------------------------------------------------------------------------

// Build a left-associative binary operator chain:
//   base (op base)* → nested BinaryExpr nodes
function leftAssoc<Op extends BinaryExpr['op']>(
  base: Combinator<Expr>,
  opParser: Combinator<Op>,
): Combinator<Expr> {
  return transform(
    sequence(base, many(sequence(opParser, base))),
    ([left, rest], span) => {
      let node: Expr = left
      for (const [op, right] of rest) {
        node = new BinaryNode(op, node, right, span)
      }
      return node
    }
  )
}

export const { expr } = rules<{ expr: Combinator<Expr> }>(g => {
  // if_expr — right-binding, not left-assoc
  const ifExpr: Combinator<Expr> = transform(
    sequence(
      regex(/if(?!\w)/), g.expr as Combinator<Expr>,
      regex(/then(?!\w)/), g.expr as Combinator<Expr>,
      regex(/else(?!\w)/), g.expr as Combinator<Expr>,
    ),
    ([, condition, , then, , else_], span): Expr => new IfNode(condition, then, else_, span)
  )

  // call = atom ('(' args ')')?
  const atom: Combinator<Expr> = choice(
    number,
    boolTrue,
    boolFalse,
    transform(
      sequence(literal('('), g.expr as Combinator<Expr>, literal(')')),
      ([, e]) => e
    ),
    ident,  // after keywords so 'true'/'false'/'if' can't accidentally match as idents
  )

  const callArgs: Combinator<Expr[]> = transform(
    sequence(literal('('), optional(sepBy(g.expr as Combinator<Expr>, literal(','))), literal(')')),
    ([, args]) => args ?? []
  )

  const call: Combinator<Expr> = transform(
    sequence(atom, optional(callArgs)),
    ([callee, args], span) => {
      if (args === null) return callee
      if (callee.type !== 'ident') return callee  // only ident can be a callee
      return new CallNode(callee.name, args, span)
    }
  )

  // Unary
  const unary: Combinator<Expr> = choice(
    transform(
      sequence(literal('-'), call),
      ([, operand], span): Expr => new UnaryNode('-', operand, span),
    ),
    transform(
      sequence(literal('!'), call),
      ([, operand], span): Expr => new UnaryNode('!', operand, span),
    ),
    call,
  )

  const mulExpr = leftAssoc(unary, choice(literal('*'), literal('/')) as Combinator<'*' | '/'>)
  const addExpr = leftAssoc(mulExpr, choice(literal('+'), literal('-')) as Combinator<'+' | '-'>)
  const cmpExpr = leftAssoc(addExpr, choice(
    literal('<='), literal('>='), literal('<'), literal('>'),
  ) as Combinator<BinaryExpr['op']>)
  const eqExpr  = leftAssoc(cmpExpr, choice(literal('=='), literal('!=')) as Combinator<'==' | '!='>)
  const andExpr = leftAssoc(eqExpr, literal('&&') as Combinator<'&&'>)
  const orExpr  = leftAssoc(andExpr, literal('||') as Combinator<'||'>)

  return {
    expr: choice(ifExpr, orExpr) as Combinator<Expr>,
  }
})

// ---------------------------------------------------------------------------
// Public parse function
// ---------------------------------------------------------------------------

export const exprParser = parser({ trivia: ws }, expr)

export function parseExpr(input: string) {
  return exprParser.parse(input)
}
