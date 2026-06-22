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
  transform, parser, parse, trivia,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import type { Expr, BinaryExpr } from './ast.ts'

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const ws = trivia(regex(/\s*/))

const number: Combinator<Expr> = transform(
  regex(/-?[0-9]+(?:\.[0-9]+)?/),
  (s, span) => ({ type: 'number', value: parseFloat(s), span }) as Expr
)

const boolTrue: Combinator<Expr> = transform(
  regex(/true(?!\w)/),
  (_, span) => ({ type: 'bool', value: true, span }) as Expr
)

const boolFalse: Combinator<Expr> = transform(
  regex(/false(?!\w)/),
  (_, span) => ({ type: 'bool', value: false, span }) as Expr
)

const ident: Combinator<Expr> = transform(
  regex(/[a-zA-Z_]\w*/),
  (name, span) => ({ type: 'ident', name, span }) as Expr
)

// ---------------------------------------------------------------------------
// Expression grammar (recursive via parser())
// ---------------------------------------------------------------------------

// Build a left-associative binary operator chain:
//   base (op base)* → nested BinaryExpr nodes
function leftAssoc<Op extends string>(
  base: Combinator<Expr>,
  opParser: Combinator<Op>,
): Combinator<Expr> {
  return transform(
    sequence(base, many(sequence(opParser, base))),
    ([left, rest], span) => {
      let node: Expr = left
      for (const [op, right] of rest) {
        node = { type: 'binary', op, left: node, right, span } as Expr
      }
      return node
    }
  )
}

export const { expr } = parser<{ expr: Combinator<Expr> }>(g => {
  // if_expr — right-binding, not left-assoc
  const ifExpr: Combinator<Expr> = transform(
    sequence(
      regex(/if(?!\w)/), g.expr as Combinator<Expr>,
      regex(/then(?!\w)/), g.expr as Combinator<Expr>,
      regex(/else(?!\w)/), g.expr as Combinator<Expr>,
    ),
    ([, condition, , then, , else_], span) =>
      ({ type: 'if', condition, then, else: else_, span }) as Expr
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
      return { type: 'call', callee: callee.name, args, span } as Expr
    }
  )

  // Unary
  const unary: Combinator<Expr> = choice(
    transform(
      sequence(literal('-'), call),
      ([, operand], span) => ({ type: 'unary', op: '-', operand, span }) as Expr,
    ),
    transform(
      sequence(literal('!'), call),
      ([, operand], span) => ({ type: 'unary', op: '!', operand, span }) as Expr,
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

export function parseExpr(input: string) {
  return parse(expr, input, { trivia: ws })
}
