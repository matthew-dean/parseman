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

/**
 * Postfix repetition operator for an item count of `min..max`. The unbounded
 * counts keep their familiar `* + ?` spelling; a genuinely bounded repeat gets
 * the regex-style `{n,m}` form, since plain W3C EBNF has no way to say it and
 * silently rendering `x{3,8}` as `x+` understates the grammar.
 */
function repeatOp(min: number, max: number | undefined): string {
  if (max === undefined) {
    if (min === 0) return '*'
    if (min === 1) return '+'
    return `{${min},}`
  }
  if (max === min) return min === 1 ? '' : `{${min}}`
  if (min === 0 && max === 1) return '?'
  return `{${min},${max}}`
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
          return r.text.length === 0 ? '/* empty */' : wrap(r.text, r.level, ALT)
        })
        .join(' | ')
      return { text, level: ALT }
    }

    case 'star':
    case 'plus':
    case 'opt': {
      const r = render(node.item)
      const op = node.kind === 'opt'
        ? '?'
        : node.kind === 'star'
          ? repeatOp(0, node.max)
          : repeatOp(node.min ?? 1, node.max)
      return { text: `${wrap(r.text, r.level, ATOM)}${op}`, level: ATOM }
    }

    case 'sepBy': {
      const item = render(node.item)
      const sep = render(node.sep)
      const itemA = wrap(item.text, item.level, ATOM)
      const sepA = wrap(sep.text, sep.level, CAT)
      // The tail repeats `(sep item)` ONE FEWER time than there are items, so the
      // item bounds shift down by one to become the tail's bounds.
      const tail = `(${sepA} ${itemA})${repeatOp(Math.max(node.min - 1, 0), node.max === undefined ? undefined : node.max - 1)}`
      const trail = node.trailing === 'allow' ? ` ${sepA}?` : ''
      const body = `${itemA} ${tail}${trail}`
      // Only a min-0 list is OPTIONAL. Any `min >= 1` requires that many items and
      // can never match empty — rendering it `( … )?` claimed the opposite.
      return node.min === 0 ? { text: `(${body})?`, level: ATOM } : { text: body, level: CAT }
    }

    case 'not': {
      const r = render(node.item)
      return { text: `!${wrap(r.text, r.level, ATOM)}`, level: ATOM }
    }

    // PEG notation: `&` positive lookahead, `!` negative.
    case 'peek': {
      const r = render(node.item)
      return { text: `&${wrap(r.text, r.level, ATOM)}`, level: ATOM }
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
