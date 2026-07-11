/**
 * Railroad-diagram (syntax-diagram) emitter. Converts the spec model to a
 * self-contained HTML page that renders SVG railroad diagrams — one per
 * production — using a vendored copy of tabatkins/railroad-diagrams (CC0).
 *
 * The page has no external dependencies: the diagram library and its CSS are
 * inlined, so it renders offline and drops straight into a docs site.
 */
import type { Production, SpecModel, SpecNode } from './model.ts'
import { renderExpr } from './ebnf.ts'
import { RAILROAD_CSS, RAILROAD_JS } from './railroad-lib.ts'

const j = (s: string): string => JSON.stringify(s)

/** Convert a spec node to a railroad-diagrams DSL expression string. */
function toDsl(node: SpecNode): string {
  switch (node.kind) {
    case 'terminal':
      return `Terminal(${j(node.text)})`
    case 'ref':
      return `NonTerminal(${j(node.name)})`
    case 'empty':
      return `Skip()`
    case 'annotation':
      return `Comment(${j(node.text)})`
    case 'seq':
      return `Sequence(${node.items.map(toDsl).join(', ')})`
    case 'choice':
      return `Choice(0, ${node.items.map(toDsl).join(', ')})`
    case 'star':
      return `ZeroOrMore(${toDsl(node.item)})`
    case 'plus':
      return `OneOrMore(${toDsl(node.item)})`
    case 'opt':
      return `Optional(${toDsl(node.item)})`
    case 'sepBy':
      // OneOrMore(item, separator): the separator rides the repeat loop.
      return `OneOrMore(${toDsl(node.item)}, ${toDsl(node.sep)})`
    case 'not':
      return `Sequence(Comment("not"), ${toDsl(node.item)})`
  }
}

// Vendored railroad-diagrams builders, evaluated once. `.toString()` on the
// result walks an in-memory FakeSVG tree and emits SVG markup with no DOM — so a
// diagram can be rendered to a static SVG string at build time (Node), not just
// in the browser. The library exports onto `exports` when it's an object.
type RailroadBuilders = {
  Diagram: (item: unknown) => { toString(): string }
  Sequence: (...xs: unknown[]) => unknown
  Choice: (normal: number, ...xs: unknown[]) => unknown
  Optional: (x: unknown) => unknown
  OneOrMore: (x: unknown, sep?: unknown) => unknown
  ZeroOrMore: (x: unknown) => unknown
  Terminal: (t: string) => unknown
  NonTerminal: (t: string) => unknown
  Comment: (t: string) => unknown
  Skip: () => unknown
}
let _builders: RailroadBuilders | null = null
function builders(): RailroadBuilders {
  if (_builders) return _builders
  const mod = {} as Record<string, unknown>
  // eslint-disable-next-line no-new-func
  new Function('exports', RAILROAD_JS)(mod)
  _builders = mod as unknown as RailroadBuilders
  return _builders
}

/** Build a railroad-diagrams object from a spec node (mirrors `toDsl`, but live). */
function toDiagramNode(b: RailroadBuilders, node: SpecNode): unknown {
  switch (node.kind) {
    case 'terminal': return b.Terminal(node.text)
    case 'ref': return b.NonTerminal(node.name)
    case 'empty': return b.Skip()
    case 'annotation': return b.Comment(node.text)
    case 'seq': return b.Sequence(...node.items.map((n) => toDiagramNode(b, n)))
    case 'choice': return b.Choice(0, ...node.items.map((n) => toDiagramNode(b, n)))
    case 'star': return b.ZeroOrMore(toDiagramNode(b, node.item))
    case 'plus': return b.OneOrMore(toDiagramNode(b, node.item))
    case 'opt': return b.Optional(toDiagramNode(b, node.item))
    case 'sepBy': return b.OneOrMore(toDiagramNode(b, node.item), toDiagramNode(b, node.sep))
    case 'not': return b.Sequence(b.Comment('not'), toDiagramNode(b, node.item))
  }
}

/** One production rendered to a static SVG string. */
export type RailroadSvg = { name: string; svg: string }

/**
 * Render each production to a self-contained **static SVG** string — no DOM and
 * no client-side script, so a diagram can be inlined straight into a docs page,
 * README, or any HTML. Pair each SVG with [`RAILROAD_CSS`](./railroad-lib) (scope
 * it to a container) to style the strokes and boxes.
 */
export function renderRailroadSvg(model: SpecModel): RailroadSvg[] {
  const b = builders()
  return model.productions.map((p) => ({
    name: p.name,
    svg: b.Diagram(toDiagramNode(b, p.expr)).toString(),
  }))
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function slug(name: string): string {
  return 'rule-' + name.replace(/[^\w-]/g, '_')
}

export type RailroadHtmlOptions = {
  /** Page `<title>` and top heading. Default: "Grammar". */
  title?: string
  /** Show the EBNF production text under each diagram. Default: true. */
  showEbnf?: boolean
}

const PAGE_CSS = `
  /* The railroad SVGs ship a fixed light background, so the page commits to a
     light theme for a consistent look regardless of the viewer's OS setting. */
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem 2.5rem;
         color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
  .subtitle { color: #666; margin: 0 0 2rem; }
  .toc { columns: 3 12rem; margin: 0 0 2.5rem; padding: 1rem 1.25rem; background: #f6f4f1; border-radius: 8px; }
  .toc a { display: block; color: #0b6; text-decoration: none; font-family: monospace; padding: 1px 0; }
  .toc a:hover { text-decoration: underline; }
  .rule { margin: 0 0 2.75rem; padding-top: 0.5rem; border-top: 1px solid #eee; }
  .rule h2 { font-size: 1.1rem; font-family: monospace; margin: 0 0 0.75rem; }
  .rule h2 a { color: #bbb; text-decoration: none; font-weight: normal; }
  .rule h2 a:hover { color: #0b6; }
  .ebnf { margin: 0.5rem 0 0; padding: 0.5rem 0.75rem; background: #f6f4f1; border-radius: 6px;
          font-family: monospace; font-size: 12px; white-space: pre-wrap; overflow-x: auto; }
  .diagram { overflow-x: auto; }
  /* The vendored library sizes each shape as (chars * 8 + padding), which assumes
     an 8px glyph advance (0.5em at 16px). Its own 14px-bold CSS actually advances
     ~8.4px/char, so long terminals crowd the box edges. Drop the text to 13px
     (advance ~7.8px) to restore comfortable side padding, and nudge the baked
     baseline (y+4) down slightly so glyphs sit vertically centered in the shapes. */
  svg.railroad-diagram text { font-size: 13px; }
  svg.railroad-diagram text:not(.comment) { transform: translateY(0.75px); }
`

/** Render the spec model as a self-contained HTML page of railroad diagrams. */
export function renderRailroadHtml(model: SpecModel, options: RailroadHtmlOptions = {}): string {
  const title = options.title ?? 'Grammar'
  const showEbnf = options.showEbnf ?? true

  const toc = model.productions
    .map(p => `<a href="#${slug(p.name)}">${escapeHtml(p.name)}</a>`)
    .join('\n    ')

  const sections = model.productions
    .map((p: Production) => {
      const ebnf = showEbnf
        ? `<div class="ebnf">${escapeHtml(`${p.name} ::= ${renderExpr(p.expr) || '/* empty */'}`)}</div>`
        : ''
      return `  <section class="rule" id="${slug(p.name)}">
    <h2><a href="#${slug(p.name)}">§</a> ${escapeHtml(p.name)}</h2>
    <div class="diagram" data-rule="${escapeHtml(p.name)}"></div>
    ${ebnf}
  </section>`
    })
    .join('\n')

  // One DSL expression per rule, built into its container at load time.
  const builders = model.productions
    .map(p => `  { name: ${j(p.name)}, dsl: function(){ return Diagram(${toDsl(p.expr)}); } }`)
    .join(',\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${RAILROAD_CSS}
${PAGE_CSS}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">Syntax diagrams generated from the parser grammar.</p>
<nav class="toc">
    ${toc}
</nav>
${sections}
<script>
${RAILROAD_JS}
</script>
<script>
(function () {
  var rules = [
${builders}
  ];
  rules.forEach(function (r) {
    var host = document.querySelector('.diagram[data-rule=' + CSS.escape(r.name) + ']');
    if (!host) return;
    try { r.dsl().addTo(host); }
    catch (e) { host.textContent = 'diagram error: ' + e.message; }
  });
})();
</script>
</body>
</html>
`
}
