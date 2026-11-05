/**
 * The instrumentation build behind the call-count and duplicate-function gates.
 *
 * Nothing here is imported by `src/`, so none of it reaches a published artifact.
 * It rewrites a COPY of an already-built bundle (or a `new Function` body) in a
 * bench process, and only that copy is run.
 *
 * - `instrument(code)` puts one counter increment at the entry of every function
 *   (`__pmK.c`) and one in front of every branch test (`__pmK.b`): `if`, `?:`, the
 *   left operand of `&&`/`||`/`??`, logical assignment, loop tests and `switch`.
 *   The counts are a property of the code and the input, not of the machine, so
 *   they are the same on a laptop and on a loaded runner.
 *
 * The function normaliser the duplicate-function gate and INV-13 share is
 * `scripts/function-shapes.mjs`.
 */
import MagicString from 'magic-string'
import { FUNCTION, children, isNode, parseModule, type AstNode } from '../../scripts/function-shapes.mjs'

/** The global the instrumented code counts into. The runner defines it before loading anything. */
export const COUNTER = '__pmK'

export function instrument(code: string, filename = 'bundle.mjs'): string {
  const s = new MagicString(code)
  const open = (n: AstNode, tag: 'b' | 'c'): void => { s.appendLeft(n.start, `(${COUNTER}.${tag}++,`) }
  const close = (n: AstNode): void => { s.prependLeft(n.end, ')') }
  const wrap = (n: unknown, tag: 'b' | 'c' = 'b'): void => {
    if (!isNode(n)) return
    open(n, tag)
    close(n)
  }
  const visit = (n: AstNode): void => {
    if (FUNCTION.has(n.type)) {
      const body = n['body']
      if (isNode(body) && body.type === 'BlockStatement') {
        // After the directive prologue: a statement in front of "use strict" demotes it.
        const stmts = body['body'] as AstNode[]
        let at = body.start + 1
        for (const st of stmts) {
          if (typeof st['directive'] !== 'string') break
          at = st.end
        }
        s.appendLeft(at, `${COUNTER}.c++;`)
      } else if (isNode(body)) {
        wrap(body, 'c')
      }
    }
    switch (n.type) {
      case 'IfStatement':
      case 'ConditionalExpression':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
        wrap(n['test'])
        break
      case 'SwitchStatement':
        wrap(n['discriminant'])
        break
      case 'LogicalExpression':
        wrap(n['left'])
        break
      case 'AssignmentExpression':
        if (n['operator'] === '||=' || n['operator'] === '&&=' || n['operator'] === '??=') wrap(n)
        break
    }
    for (const c of children(n)) visit(c)
  }
  visit(parseModule(code, filename))
  const out = s.toString()
  // A rewrite that does not re-parse would fail later, inside a measurement, as a
  // confusing load error. Fail here instead, naming the file.
  parseModule(out, filename)
  return out
}

/** A `new Function` body, instrumented as the body of the function it becomes. */
export function instrumentFunctionBody(body: string): string {
  const pre = '(function(){'
  const post = '\n})'
  const out = instrument(pre + body + post, 'function-body.js')
  if (!out.startsWith(pre) || !out.endsWith(post)) throw new Error('instrumentFunctionBody: wrapper was rewritten')
  return out.slice(pre.length, -post.length)
}
