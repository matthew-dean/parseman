/** Types for `lang-node.js`. */
import type { Span } from '../../src/types.ts'
import type { NumberLit, BoolLit, Ident, BinaryExpr, UnaryExpr, CallExpr, IfExpr, Expr } from './ast.ts'
export declare const NumberNode: new (value: number, span: Span) => NumberLit
export declare const BoolNode: new (value: boolean, span: Span) => BoolLit
export declare const IdentNode: new (name: string, span: Span) => Ident
export declare const BinaryNode: new (op: BinaryExpr['op'], left: Expr, right: Expr, span: Span) => BinaryExpr
export declare const UnaryNode: new (op: UnaryExpr['op'], operand: Expr, span: Span) => UnaryExpr
export declare const CallNode: new (callee: string, args: Expr[], span: Span) => CallExpr
export declare const IfNode: new (condition: Expr, then: Expr, else_: Expr, span: Span) => IfExpr
