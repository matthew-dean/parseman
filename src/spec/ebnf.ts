/**
 * EBNF (W3C-style) text emitter for the grammar spec model.
 *
 * Precedence, lowest → highest: alternation (`|`) < concatenation (space) <
 * postfix (`* + ?`) < atom. The renderer parenthesizes only where a lower-
 * precedence construct sits inside a higher-precedence one.
 */
import type { Production, SpecModel, SpecNode } from './model.ts'

const ALT = 1 // choice
const CAT = 2 // sequence
const ATOM = 3 // terminal, ref, postfix, parenthesized

function quote(s: string): string {
  // W3C EBNF uses quoted string terminals; prefer double quotes, fall back to
  // single quotes when the literal itself contains a double quote.
  if (s.includes('"') && !s.includes("'")) return `'${s}'`
  return `"${s.replace(/"/g, '\\"')}"`
}

function wrap(inner: string, innerLevel: number, minLevel: number): string {
  return innerLevel < minLevel ? `(${inner})` : inner
}

/** Render a node, returning its text and precedence level. */
function render(node: SpecNode): { text: string; level: number } {
  switch (node.kind) {
    case 'terminal':
      return { text: node.literal ? quote(node.text) : node.text, level: ATOM }
    case 'ref':
      return { text: node.name, level: ATOM }
    case 'empty':
      return { text: '', level: ATOM }
    case 'annotation':
      return { text: `/* ${node.text} */`, level: ATOM }

    case 'seq': {
      const text = node.items
        .map(it => {
          const r = render(it)
          return wrap(r.text, r.level, CAT)
        })
        .filter(t => t.length > 0)
        .join(' ')
      return { text, level: CAT }
    }

    case 'choice': {
      const text = node.items
        .map(it => {
          const r = render(it)
          return wrap(r.text, r.level, ALT)
        })
        .join(' | ')
      return { text, level: ALT }
    }

    case 'star':
    case 'plus':
    case 'opt': {
      const r = render(node.item)
      const op = node.kind === 'star' ? '*' : node.kind === 'plus' ? '+' : '?'
      return { text: `${wrap(r.text, r.level, ATOM)}${op}`, level: ATOM }
    }

    case 'sepBy': {
      const item = render(node.item)
      const sep = render(node.sep)
      const itemA = wrap(item.text, item.level, ATOM)
      const sepA = wrap(sep.text, sep.level, CAT)
      // item (sep item)*
      return { text: `${itemA} (${sepA} ${itemA})*`, level: CAT }
    }

    case 'not': {
      const r = render(node.item)
      return { text: `!${wrap(r.text, r.level, ATOM)}`, level: ATOM }
    }
  }
}

function renderProduction(p: Production): string {
  const { text } = render(p.expr)
  return `${p.name} ::= ${text || '/* empty */'}`
}

/** Render the whole spec model as EBNF text (one production per line). */
export function renderEBNF(model: SpecModel): string {
  return model.productions.map(renderProduction).join('\n') + '\n'
}

/** Render a single production's right-hand side (no `name ::=`). */
export function renderExpr(node: SpecNode): string {
  return render(node).text
}
