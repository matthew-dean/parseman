import type { Span } from '../../src/types.ts'

// Typed AST nodes for a small expression language.
// Every node carries its source span for error reporting / IDE tooling.

export type Expr =
  | NumberLit
  | BoolLit
  | Ident
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | IfExpr

export type NumberLit = { type: 'number'; value: number; span: Span }
export type BoolLit   = { type: 'bool';   value: boolean; span: Span }
export type Ident     = { type: 'ident';  name: string; span: Span }

export type BinaryExpr = {
  type: 'binary'
  op: '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||'
  left: Expr
  right: Expr
  span: Span
}

export type UnaryExpr = {
  type: 'unary'
  op: '-' | '!'
  operand: Expr
  span: Span
}

export type CallExpr = {
  type: 'call'
  callee: string
  args: Expr[]
  span: Span
}

export type IfExpr = {
  type: 'if'
  condition: Expr
  then: Expr
  else: Expr
  span: Span
}
