#!/usr/bin/env node
/**
 * INVARIANT GATE — mechanical checks for the defect classes this repo has
 * already paid for, so that a written rule can stop a commit instead of only
 * describing one.
 *
 * Every check here is SOURCE-DECIDABLE: it parses `src/**` with oxc (already a
 * runtime dependency) and decides on the AST. Nothing here times anything,
 * nothing here samples, and nothing here guesses. A check that could not be made
 * to decide without a heuristic was left OUT rather than shipped noisy — see
 * docs/design/invariant-gate.md for the ones that were rejected and why. That is
 * the same argument docs/design/release-gates.md makes about the changelog gate:
 * a gate that fires on a comment typo gets bypassed, and then the gates that
 * matter get bypassed with it.
 *
 * The rules:
 *   INV-1  no accessor descriptor installed with Object.defineProperty
 *   INV-2  no field in a public `*Options` type that nothing reads
 *   INV-3  every module under src/ is reachable from a published entry point
 *   INV-4  no declaration body duplicated across modules
 *   INV-5  no `delete` on an object the enclosing function did not construct
 *   INV-6  no assembled piece body reads a per-parse config field
 *   INV-7  no combinator parse path reads a construction-time option
 *   INV-8  no exported NAME resolves to two different declarations
 *   INV-9  no cross-module KEY string minted in more than one module
 *   INV-10 no comment naming a repo path that does not exist
 *
 * INV-8/9/10 are the NAMING rules. They exist because every duplicate-definition
 * defect this project has paid for was found by accident, and three of the five
 * are decidable from names alone: one name meaning two things (INV-8), one key
 * spelled independently in two places (INV-9), and prose naming code that is
 * gone (INV-10). See docs/design/invariant-gate.md for which of the five each
 * rule would have caught — and for the two that NONE of them catch, which is the
 * honest limit of a naming gate.
 *
 * Usage:
 *   node scripts/check-invariants.mjs            # gate — exits 1 on any new finding
 *   node scripts/check-invariants.mjs --list     # print every finding, exit 0
 *   node scripts/check-invariants.mjs --json     # machine-readable
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSync } from 'oxc-parser'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * `--root=<dir>` points the whole gate at another tree that has a
 * `package.json` and a `src/`. That is how test/unit/invariant-gate.test.ts
 * proves each rule FIRES: it runs this exact script, the way CI runs it,
 * against fixture trees that contain one planted violation each. A gate that
 * has never been observed failing is not known to work.
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : REPO
const SRC = join(ROOT, 'src')
/** The allowlist describes THIS repo; a fixture tree gets none. `--assert-allowlist`
 *  forces it back on, which is how the stale-entry failure is exercised. */
const USE_ALLOW = !rootArg || process.argv.includes('--assert-allowlist')

/* ------------------------------------------------------------------ *
 * ALLOWLIST — loaded from scripts/invariant-allowlist.mjs, which carries the
 * entries, their categories, and the committed count. It is a separate module
 * for two reasons: the count is a single reviewable line rather than a fact
 * buried in a list, and a fixture tree can supply its OWN allowlist so that the
 * checks below can be observed FAILING (test/unit/invariant-gate.test.ts).
 *
 * Three things are enforced here, none of which were before:
 *
 *   RATCHET    `ALLOW.size` must equal the committed `ALLOW_COUNT` exactly.
 *              "THIS LIST MAY ONLY GET SHORTER" was a sentence in a comment;
 *              this is the sentence with teeth. Adding an entry now costs a
 *              deliberate edit to a numbered line that shows up in review on
 *              its own, instead of one more line hiding among sixteen.
 *              It is a ratchet, not a wall: a real architectural change that
 *              retires modules from the export graph raises the count in the
 *              same commit and the gate goes green (proven in the test file).
 *              A ratchet that cannot be raised is a hard block, and a hard
 *              block gets bypassed, taking the rules that matter with it.
 *   STRUCTURE  Every entry declares a category — RULE-BUG / BY-DESIGN / DEBT —
 *              and DEBT declares a tracking ref. An entry with neither owner
 *              nor expiry is a silent, permanent decision to not do the work.
 *   STALENESS  An entry whose finding no longer exists fails the gate, so an
 *              exemption cannot outlive the violation it names. (Pre-existing;
 *              reported alongside the two above.)
 *
 * BY-DESIGN VS DEBT IS THE WHOLE POINT — READ THIS BEFORE ADDING AN ENTRY.
 * The two look identical on the day they are written and could not be more
 * different a year later.
 *
 *   BY-DESIGN  is a finished argument. The code is staying in this shape. The
 *              entry leaves only if the design changes — `src/table/
 *              exec-baseline.ts` is unimported BECAUSE it is a frozen control,
 *              and reference code deliberately retired from the product path
 *              while the measurement harness still reaches it is the same
 *              shape.
 *   DEBT       is an unfinished obligation. Something is owed, and the `ref`
 *              names who owes it.
 *
 * `INV-3 token-alphabet.ts` / `token-scanner.ts` is why this is enforced rather
 * than trusted. The rule CORRECTLY caught built-but-never-wired analysis — the
 * sixth instance of that shape in this project — and the entry stated a real
 * obligation, "wire into the compiler or delete". Nothing enforced the
 * obligation and nothing ever restated it, so over time it read exactly like
 * the frozen-control entries above it: a permanent, accepted exemption. Debt
 * decays into by-design by neglect, never the other way round. Naming the
 * category and PRINTING the DEBT list on every run, pass or fail, is what stops
 * that: debt that is never restated is debt that is never paid.
 * ------------------------------------------------------------------ */
const ALLOW_MODULE = 'scripts/invariant-allowlist.mjs'
/** A fixture tree with its own allowlist uses it; otherwise `--assert-allowlist`
 *  means "run THIS repo's allowlist against that tree", which is how the
 *  stale-entry failure is exercised. */
const allowRoot = !USE_ALLOW ? null : existsSync(join(ROOT, ALLOW_MODULE)) ? ROOT : REPO
const allowMod = allowRoot ? await import(pathToFileURL(join(allowRoot, ALLOW_MODULE)).href) : null
/** @type {Map<string, { category: string, why: string, ref?: string }>} */
const ALLOW = allowMod?.ALLOW ?? new Map()
const CATEGORIES = allowMod?.CATEGORIES ?? []

if (allowMod) {
  /** @type {string[]} */
  const bad = []
  for (const [key, entry] of ALLOW) {
    if (!entry || typeof entry !== 'object') { bad.push(`${key} — entry is not an object { category, why, ref? }`); continue }
    if (!CATEGORIES.includes(entry.category)) bad.push(`${key} — category must be one of ${CATEGORIES.join(' / ')}, got ${JSON.stringify(entry.category)}`)
    if (typeof entry.why !== 'string' || !entry.why.trim()) bad.push(`${key} — \`why\` must be a non-empty string`)
    if (entry.category === 'DEBT' && (typeof entry.ref !== 'string' || !entry.ref.trim())) bad.push(`${key} — DEBT requires a \`ref\`: name the lane, doc, or issue that owns the fix`)
  }
  if (bad.length) {
    console.error(`invariant gate: malformed allowlist entr${bad.length === 1 ? 'y' : 'ies'} in ${ALLOW_MODULE}.`)
    console.error('Every entry needs a category (RULE-BUG / BY-DESIGN / DEBT) and a reason; DEBT needs a tracking ref.\n  ' + bad.join('\n  '))
    process.exit(1)
  }
  if (ALLOW.size !== allowMod.ALLOW_COUNT) {
    const verb = ALLOW.size > allowMod.ALLOW_COUNT ? 'GREW' : 'shrank'
    console.error(`invariant gate: the allowlist ${verb} — ${ALLOW.size} entries against a committed ALLOW_COUNT of ${allowMod.ALLOW_COUNT}.`)
    console.error(ALLOW.size > allowMod.ALLOW_COUNT
      ? `The list may only get SHORTER. Fix the code, or argue the invariant is wrong. If the entry is genuinely\nunavoidable, raise ALLOW_COUNT to ${ALLOW.size} in ${ALLOW_MODULE} in the same commit — that edit is the review.`
      : `Lower ALLOW_COUNT to ${ALLOW.size} in ${ALLOW_MODULE}. Leaving it high is slack a later commit spends for free.`)
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ */

/** @returns {string[]} every non-declaration .ts file under src/, repo-relative */
function sources(dir = SRC, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(relative(ROOT, p))
  }
  return out
}

/** Depth-first walk of an oxc/ESTree program. `visit` sees every node with a `type`. */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (typeof node.type === 'string') visit(node)
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
    walk(node[key], visit)
  }
}

/**
 * Walk carrying the nearest enclosing named function/variable, so a finding's
 * KEY can be `file:enclosingName` instead of `file:line`. A line-numbered key
 * goes stale the moment anything above it moves, which would turn the
 * allowlist into a source of red on unrelated edits — the precise thing that
 * gets a gate switched off.
 */
function walkScoped(node, visit, scope = '<module>') {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walkScoped(n, visit, scope); return }
  if (typeof node.type === 'string') {
    visit(node, scope)
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') scope = node.id?.name ?? scope
    else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) scope = node.id.name
    else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') scope = keyName(node) ?? scope
  }
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
    walkScoped(node[key], visit, scope)
  }
}

const isId = (n, name) => n && n.type === 'Identifier' && n.name === name

/** oxc keeps `(…)` and TS assertion wrappers in the tree; look through them. */
function unwrap(n) {
  while (n && (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression'
    || n.type === 'TSNonNullExpression' || n.type === 'TSSatisfiesExpression')) n = n.expression
  return n
}

/** Property key as a plain string, or null when computed/unknowable. */
function keyName(p) {
  if (!p || p.computed) return null
  const k = p.key
  if (!k) return null
  if (k.type === 'Identifier') return k.name
  if (k.type === 'Literal' && typeof k.value === 'string') return k.value
  return null
}

/* ================================================================== *
 * Load and parse everything once.
 * ================================================================== */
const files = sources()
/** @type {Map<string, { code: string, ast: any, comments: any[], lineAt: (i: number) => number }>} */
const parsed = new Map()
for (const f of files) {
  const code = readFileSync(join(ROOT, f), 'utf8')
  const r = parseSync(f, code, { lang: 'ts' })
  // Precompute line starts once per file (invariant 10 in jess's V8-ARCHITECTURE:
  // a source-derived fact has one owner and one construction point).
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1)
  const lineAt = (idx) => {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 }
    return lo + 1
  }
  parsed.set(f, { code, ast: r.program, comments: r.comments ?? [], lineAt })
}

/** @type {{ rule: string, key: string, file: string, line: number, message: string }[]} */
const findings = []
const report = (rule, file, line, message, key) =>
  findings.push({ rule, key: key ?? `${rule}:${file}:${line}`, file, line, message })

/* ================================================================== *
 * INV-1 — no accessor descriptor installed with Object.defineProperty.
 *
 * DECIDES: a `get`/`set` in an `Object.defineProperty` / `defineProperties`
 * descriptor. That installs an ACCESSOR onto an object that already exists,
 * which transitions its hidden class and makes every subsequent read of the
 * object go through a call instead of an inline cache slot.
 *
 * WHY THIS EXACT SHAPE: the 0.44.0 migration aid put throwing accessors on
 * every `run()` result and cost a measured 36.9% on small parses. jess has the
 * same class recorded at 46% of CSS parse time. It is the cheapest defect in
 * the catalogue to detect and the most expensive to ship.
 *
 * NOT BANNED: `get x() {}` in an object LITERAL. That is part of the object's
 * shape from birth — it does not transition anything — and this repo uses it
 * deliberately for lazy materialization (src/functional/doc.ts, src/cst/
 * trivia-entries.ts). Banning it would be the false positive that gets the
 * whole gate turned off.
 * ================================================================== */
for (const [file, { ast, lineAt }] of parsed) {
  walkScoped(ast, (n, scope) => {
    if (n.type !== 'CallExpression') return
    const c = n.callee
    if (!c || c.type !== 'StaticMemberExpression' && c.type !== 'MemberExpression') return
    if (!isId(c.object, 'Object') || c.computed) return
    const which = c.property?.name
    if (which !== 'defineProperty' && which !== 'defineProperties') return
    // defineProperty(o, k, DESC) | defineProperties(o, { k: DESC, … })
    const descs = which === 'defineProperty'
      ? [n.arguments?.[2]]
      : (n.arguments?.[1]?.type === 'ObjectExpression'
        ? n.arguments[1].properties.filter((p) => p.type === 'Property').map((p) => p.value)
        : [])
    for (const d of descs) {
      if (!d || d.type !== 'ObjectExpression') continue
      for (const p of d.properties) {
        if (p.type !== 'Property') continue
        const k = keyName(p)
        if (k === 'get' || k === 'set') {
          report('INV-1', file, lineAt(p.start),
            `accessor descriptor (\`${k}\`) installed via Object.${which} in \`${scope}\` — transitions the hidden class of an object that already exists; use a literal getter at the construction site, or a plain data property`,
            `INV-1:${file}:${scope}`)
        }
      }
    }
  })
}

/* ================================================================== *
 * INV-2 — no field declared in a public `*Options` type that nothing reads.
 *
 * DECIDES: a property name declared in an EXPORTED type/interface whose name
 * ends in `Options`, where that name appears nowhere in `src/**` as a member
 * access, a destructuring key, or a string literal.
 *
 * WHY: `dispatch()` shipped a flag that was set and never read, so the cut did
 * not fire and the parser accepted input both other engines rejected — a
 * silently truncated document, with every test green. A declared-and-unread
 * option is that bug in its general form, and it is exactly the thing a type
 * system CANNOT catch: the type is satisfied by writing the field.
 *
 * FALSE-POSITIVE FLOOR: the read set is deliberately over-broad — ANY `.name`
 * anywhere in src counts, including on unrelated objects, and so does any
 * occurrence of the bare name as a string. That under-reports (a field read
 * only through a same-named property of something else escapes) and it is the
 * right direction: this check fires only when the name occurs NOWHERE in the
 * implementation, which no reader can call a false alarm.
 * ================================================================== */
{
  /** every identifier this codebase could possibly be reading a field by */
  const readNames = new Set()
  for (const [, { ast }] of parsed) {
    walk(ast, (n) => {
      if ((n.type === 'MemberExpression' || n.type === 'StaticMemberExpression') && !n.computed && n.property?.type === 'Identifier') readNames.add(n.property.name)
      if (n.type === 'ObjectPattern') for (const p of n.properties) { const k = keyName(p); if (k) readNames.add(k) }
      if (n.type === 'Literal' && typeof n.value === 'string') readNames.add(n.value)
      if (n.type === 'TemplateElement' && n.value?.raw) for (const w of n.value.raw.split(/[^A-Za-z0-9_$]+/)) readNames.add(w)
    })
  }
  for (const [file, { ast, lineAt }] of parsed) {
    walk(ast, (n) => {
      const isExported = n.type === 'ExportNamedDeclaration' && n.declaration
      if (!isExported) return
      const d = n.declaration
      let name = null, members = null
      if (d.type === 'TSInterfaceDeclaration') { name = d.id?.name; members = d.body?.body }
      else if (d.type === 'TSTypeAliasDeclaration') {
        name = d.id?.name
        const t = d.typeAnnotation
        // `X & { … }` is the common spelling here (`RenderTarget & { … }`), so
        // take the literal members of every literal arm. A `Pick<…>` / mapped
        // arm declares no members of its own and contributes nothing — the
        // fields it selects are checked where they are DECLARED.
        if (t?.type === 'TSTypeLiteral') members = t.members
        else if (t?.type === 'TSIntersectionType') members = t.types.flatMap((a) => a.type === 'TSTypeLiteral' ? a.members : [])
      }
      if (!name || !name.endsWith('Options') || !members || !members.length) return
      for (const m of members) {
        if (m.type !== 'TSPropertySignature') continue
        const k = keyName(m)
        if (!k) continue
        if (!readNames.has(k)) {
          report('INV-2', file, lineAt(m.start),
            `\`${name}.${k}\` is declared in a public options type and is never read anywhere in src/ — a caller can set it and nothing happens`,
            `INV-2:${name}.${k}`)
        }
      }
    })
  }
}

/* ================================================================== *
 * INV-5 — no `delete` on an object the enclosing function did not construct.
 *
 * DECIDES: a `delete X.p` / `delete X[e]` whose ROOT identifier is not bound,
 * anywhere inside the enclosing function, by a declaration whose initializer
 * is a fresh object (`{…}`, `[…]`, `new …`, `Object.create(…)`). Parameters,
 * closure variables, and aliases of somebody else's object (`const m = x._meta`)
 * all fail that test; a scratch object built and discarded in the same call
 * passes it.
 *
 * WHY THIS EXACT SHAPE: one `delete` flips `%HasFastProperties` to false on an
 * object of this shape, and RE-ADDING THE PROPERTY DOES NOT RESTORE IT. That is
 * survivable on a scratch object that dies at the end of the call. It is a
 * catastrophe on a long-lived one: `delete ctx._triviaLog` runs per token and
 * per leaf on `ctx`, the single object every combinator reads on every step, so
 * the FIRST `token()` in a parse can put it in dictionary mode for the
 * remainder. Same class as INV-1, and the reason this rule is separate from a
 * blanket "no delete" is that a blanket ban would fire on the scratch case,
 * which is fine and common — and a rule that fires on fine code gets switched
 * off, taking the rules that matter with it.
 *
 * NOT A CLAIM THAT THE CODE IS WRONG. The `ctx` deletes are not gratuitous:
 * restoration there is by PRESENCE — readers test whether the property exists —
 * so `delete` is the semantically correct expression of "restore to absent" and
 * `= undefined` is not a drop-in. This is correct code with a catastrophic
 * shape consequence, which is precisely the kind a test suite cannot see.
 *
 * FALSE-POSITIVE FLOOR: the "constructed here" test is deliberately generous —
 * it searches the WHOLE enclosing function subtree, nested functions included,
 * so a locally-built object exempts the delete even when the binding is not in
 * the immediately enclosing block. That under-reports, which is the right
 * direction. Every one of the 17 findings on this tree is a genuinely
 * long-lived object; none is a scratch local.
 * ================================================================== */
for (const [file, { ast, lineAt }] of parsed) {
  /** The nearest enclosing function node, so "did THIS call build it?" is answerable. */
  const fnStack = []
  const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
    || n.type === 'ArrowFunctionExpression'

  /** Names bound in `node`'s subtree to a FRESHLY CONSTRUCTED value. */
  const constructedIn = (fn) => {
    const names = new Set()
    walk(fn, (n) => {
      if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier') return
      const init = unwrap(n.init)
      if (!init) return
      if (init.type === 'ObjectExpression' || init.type === 'ArrayExpression'
        || init.type === 'NewExpression'
        || (init.type === 'CallExpression' && init.callee?.property?.name === 'create')) names.add(n.id.name)
    })
    return names
  }
  const cache = new Map()

  const visit = (node, scope) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) visit(n, scope); return }
    if (typeof node.type === 'string') {
      if (isFn(node)) fnStack.push(node)
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') scope = node.id?.name ?? scope
      else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
        && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) scope = node.id.name
      else if (node.type === 'Property' && (node.value?.type === 'FunctionExpression' || node.value?.type === 'ArrowFunctionExpression')) scope = keyName(node) ?? scope
      else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') scope = keyName(node) ?? scope

      if (node.type === 'UnaryExpression' && node.operator === 'delete') {
        let base = unwrap(node.argument)
        let prop = null
        while (base && base.type.endsWith('MemberExpression')) {
          if (prop === null) prop = base.computed ? '<computed>' : base.property?.name ?? '<computed>'
          base = unwrap(base.object)
        }
        if (base && base.type === 'Identifier') {
          let built = false
          for (const fn of fnStack) {
            if (!cache.has(fn)) cache.set(fn, constructedIn(fn))
            if (cache.get(fn).has(base.name)) { built = true; break }
          }
          if (!built) {
            report('INV-5', file, lineAt(node.start),
              `\`delete ${base.name}.${prop}\` in \`${scope}\` — \`${base.name}\` is not constructed by this function, so the delete lands on a LONG-LIVED object. One delete flips %HasFastProperties to false and re-adding the property does not restore it; every later read of that object goes through the dictionary`,
              `INV-5:${file}:${scope}:${base.name}.${prop}`)
          }
        }
      }
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
      visit(node[key], scope)
    }
    if (typeof node.type === 'string' && isFn(node)) fnStack.pop()
  }
  visit(ast, '<module>')
}

/* ================================================================== *
 * INV-3 — every module under src/ is reachable from a published entry point.
 *
 * DECIDES: import-graph reachability from the targets of package.json
 * `exports` and `bin` (mapped dist/*.js -> src/*.ts). Static imports,
 * re-exports, `export *`, and `import()` with a literal specifier all count as
 * edges; a type-only import counts too.
 *
 * WHY: 87 KB of lowering analysis sat in the tree, never imported by the code
 * that needed it. An unreachable module is not merely dead weight in the
 * artifact — it is a piece of reasoning the shipped code is NOT doing, while
 * looking from the outside as though it does.
 *
 * FALSE-POSITIVE FLOOR: zero heuristics. If a module is genuinely bench-only,
 * it goes in ALLOW with a reason (two are there today).
 * ================================================================== */
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const distToSrc = (p) => relative(ROOT, join(ROOT, String(p).replace(/^\.\/dist\//, 'src/').replace(/\.c?js$/, '.ts')))
  const roots = []
  for (const e of Object.values(pkg.exports ?? {})) if (e?.import) roots.push(distToSrc(e.import))
  for (const b of Object.values(typeof pkg.bin === 'string' ? { _: pkg.bin } : pkg.bin ?? {})) roots.push(distToSrc(b))

  /** @type {Map<string, string[]>} */
  const edges = new Map()
  for (const [file, { ast }] of parsed) {
    const out = []
    const add = (spec) => {
      if (typeof spec !== 'string' || !spec.startsWith('.')) return
      const target = relative(ROOT, resolve(ROOT, dirname(file), spec))
      if (parsed.has(target)) out.push(target)
      else if (parsed.has(target.replace(/\.js$/, '.ts'))) out.push(target.replace(/\.js$/, '.ts'))
      else if (parsed.has(join(target, 'index.ts'))) out.push(join(target, 'index.ts'))
    }
    walk(ast, (n) => {
      if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') add(n.source?.value)
      if (n.type === 'ImportExpression') add(n.source?.value)
    })
    edges.set(file, out)
  }
  const seen = new Set()
  const stack = roots.filter((r) => parsed.has(r))
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    for (const t of edges.get(f) ?? []) stack.push(t)
  }
  for (const f of files) {
    if (seen.has(f)) continue
    report('INV-3', f, 1,
      'module is not reachable by import from any published entry point (package.json exports/bin) — it is analysis the shipped code does not run',
      `INV-3:${f}`)
  }
}

/* ================================================================== *
 * INV-4 — no constant table or function body duplicated across modules.
 *
 * DECIDES: two top-level declarations in DIFFERENT files whose initializer or
 * body is byte-identical after comments and whitespace are removed, and whose
 * normalized form is at least MIN_DUP_CHARS long.
 *
 * WHY: three copies of one ASCII fold shipped, ONE OF THEM WRONG; two copies
 * of `packInts`, one unbounded; a decoder left duplicated after its encoder
 * was deduplicated. A copy that drifts is worse than no copy, and the drift is
 * invisible to every behavioural test because each copy has its own callers.
 *
 * FALSE-POSITIVE FLOOR: byte-identity after comment/whitespace removal, so
 * there is no similarity threshold to argue about. The length floor exists
 * only to stop matching one-liners that are identical by coincidence
 * (`return x.length`); it is set high enough that a hit is a real table or a
 * real algorithm, never an idiom.
 * ================================================================== */
const MIN_DUP_CHARS = 160
{
  /** @type {Map<string, { file: string, line: number, name: string }[]>} */
  const byHash = new Map()
  for (const [file, { code, ast, comments, lineAt }] of parsed) {
    // Blank every comment once, so the normalized slice below is comment-free
    // without re-scanning the source per declaration.
    const blanked = code.split('')
    for (const c of comments) for (let i = c.start; i < c.end && i < blanked.length; i++) blanked[i] = ' '
    const clean = blanked.join('')
    const norm = (a, b) => clean.slice(a, b).replace(/\s+/g, '')

    const record = (node, name, start, end) => {
      const s = norm(start, end)
      if (s.length < MIN_DUP_CHARS) return
      if (!byHash.has(s)) byHash.set(s, [])
      byHash.get(s).push({ file, line: lineAt(start), name })
    }
    for (const stmt of ast.body ?? []) {
      const d = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
      if (!d) continue
      if (d.type === 'FunctionDeclaration' && d.body) record(d, d.id?.name ?? '<anon>', d.body.start, d.body.end)
      else if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations) {
          if (!v.init || v.id?.type !== 'Identifier') continue
          const init = unwrap(v.init)
          const body = unwrap((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') ? init.body : init)
          record(v, v.id.name, body.start, body.end)
        }
      }
    }
  }
  for (const [, sites] of byHash) {
    const distinct = [...new Set(sites.map((s) => s.file))]
    if (distinct.length < 2) continue
    const where = sites.map((s) => `${s.file}:${s.line} \`${s.name}\``).join(' , ')
    const first = sites[0]
    report('INV-4', first.file, first.line,
      `identical declaration body duplicated across modules — ${where}. Import one; a copy that drifts is worse than no copy`,
      `INV-4:${sites.map((s) => `${s.file}:${s.name}`).sort().join('|')}`)
  }
}

/* ================================================================== *
 * INV-6 — no assembled PIECE body may read a per-parse CONFIG field.
 *
 * DECIDES: a member read of one of `CONFIG_FIELDS` off the piece signature's
 * `ctx` parameter, inside a function that `src/table/assemble.ts`'s `lower`
 * returns — i.e. inside a piece.
 *
 * WHY THIS EXACT SHAPE: the table lowering's whole premise (design ledger row
 * G5) is that the branching on OPTIONS runs ONCE, at assembly, and its OUTPUT
 * is the parser path — so the path itself contains no option test. The
 * distinction the rule encodes is not "is this field private", it is WHEN the
 * field can change:
 *
 *   CONFIG   fixed by `run()` before the entry is called and constant for the
 *            whole parse — `trackLines`, the host (`build`), the trivia
 *            policy in scope. A read of one of these inside a piece is a
 *            decision that assembly should have made by SELECTING that piece.
 *            There is a tracking piece and a non-tracking piece; a CST piece
 *            and an AST piece. The piece does not know the option exists.
 *
 *   RUNTIME  varies DURING a parse — the position, the capture sinks a
 *            `node()` opens and closes, the error sink's contents. Those stay
 *            exactly where they are; resolving them early would be wrong, not
 *            fast.
 *
 * So `_cstBuf`, `_fields`, `_errors` and the other SINKS are deliberately NOT
 * on this list: `beginCstNodeCapture` sets and clears them mid-parse, and a
 * piece has to ask. `trackLines` and `build` are, because they cannot change.
 *
 * The cost this prevents is not hypothetical. Each of these reads is a load
 * plus a branch, and `benchmark.less` executes 497,360 rows — the bytecode
 * driver it replaces re-tested them on every one.
 * ================================================================== */
{
  /**
   * Fields fixed for the life of a parse. A read of one of these inside a piece
   * is the violation; a read at ASSEMBLY time (outside any piece) is the
   * intended resolution and is not reported.
   */
  const CONFIG_FIELDS = new Set(['trackLines', 'build'])
  const ASSEMBLER = 'src/table/assemble.ts'
  const entry = parsed.get(ASSEMBLER)
  if (entry) {
    const { ast, lineAt } = entry
    // A PIECE is a function whose parameter list is the piece signature —
    // `(input, pos, ctx)` — since that is what `lower` returns and what the
    // assembled graph calls. Matching on the signature rather than on position
    // inside `lower` keeps the rule decidable without dataflow, and it also
    // catches a piece factored out to a helper.
    const isPiece = (n) => {
      if (n.type !== 'ArrowFunctionExpression' && n.type !== 'FunctionExpression') return false
      const p = n.params
      if (!p || p.length !== 3) return false
      const names = p.map((x) => (x.type === 'Identifier' ? x.name : null))
      return names[2] === 'ctx' && (names[0] === 'input' || names[0] === '_input')
    }
    /** Report every config read anywhere under `node`. */
    const scan = (node, pieceLine) => {
      walkScoped(node, (n) => {
        if (n.type !== 'StaticMemberExpression' && n.type !== 'MemberExpression') return
        if (n.computed) return
        if (!isId(unwrap(n.object), 'ctx')) return
        const f = n.property?.name
        if (!CONFIG_FIELDS.has(f)) return
        report('INV-6', ASSEMBLER, lineAt(n.start),
          `piece body (opened at line ${pieceLine}) reads the per-parse config field \`ctx.${f}\` — that decision belongs to assembly, which should SELECT a piece rather than emit one that tests; see RunCfg`,
          `INV-6:${ASSEMBLER}:${f}:${pieceLine}`)
      })
    }
    walkScoped(ast, (n) => { if (isPiece(n)) scan(n.body, lineAt(n.start)) })
  }
}

/* ================================================================== *
 * INV-7 — no combinator `parse` body may read a CONSTRUCTION-TIME OPTION.
 *
 * DECIDES: a member read off an identifier named `opts` / `options` / `_opts`
 * inside a function that is a combinator's `parse` — either the property
 * `parse(...)` of an object literal, or any `(input, pos, ctx)` body.
 *
 * WHY: this is INV-6's rule for the OTHER engine. `parser(opts, root)` fixes
 * `opts` when the grammar is built; a `parse` body that reads it is asking a
 * question whose answer was already known, once per scope entry, for the whole
 * life of the process. `combinators/grammar.ts` read NINE of them per entry —
 * `trivia` five times, `trackLines`, `captureTrivia`, `captureTriviaKinds`
 * twice — and a nested `parser({ trivia })` region is entered as often as the
 * rule containing it runs.
 *
 * The resolution is the same one INV-6 names: decide at LINK time and SELECT a
 * pre-written variant, rather than emit one body that tests. Overgeneration is
 * cheap; a per-entry test is not.
 *
 * DELIBERATELY NOT FLAGGED: `ctx` reads. A `ctx.trivia` / `ctx.captureTrivia`
 * read is per-scope RUNTIME state that `node()` opens and closes mid-parse, not
 * configuration — resolving it early would be wrong, not fast. INV-6 draws the
 * same line for the same reason.
 *
 * ALSO NOT FLAGGED: the top-level `parse(combinator, input, opts)` entry, whose
 * `opts` arrive per CALL. That is the run-start boundary, the same irreducible
 * consult `AssemblyCache.forCtx` carries the argument for.
 * ================================================================== */
{
  const OPTION_BASES = new Set(['opts', 'options', '_opts'])
  /**
   * THE CRITERION IS WHERE THE BINDING COMES FROM, not which file it is in.
   *
   * An `opts` that is a PARAMETER of the parse function arrives per CALL — that
   * is the run-start boundary (`parse(combinator, input, opts)`, a language
   * service's `parse(src, opts)`), the same irreducible consult
   * `AssemblyCache.forCtx` carries the argument for. An `opts` captured from an
   * ENCLOSING scope was fixed when the combinator was built, and reading it here
   * is the violation.
   */
  const paramNames = (fn) => {
    const out = new Set()
    const add = (x) => {
      if (!x || typeof x !== 'object') return
      if (x.type === 'Identifier') out.add(x.name)
      else if (x.type === 'AssignmentPattern') add(x.left)
      else if (x.type === 'RestElement') add(x.argument)
      else if (x.type === 'ObjectPattern') for (const q of x.properties ?? []) add(q.value ?? q.argument)
      else if (x.type === 'ArrayPattern') for (const q of x.elements ?? []) add(q)
      else if (x.type === 'TSParameterProperty') add(x.parameter)
    }
    for (const x of fn.params ?? []) add(x)
    return out
  }
  for (const [file, entry] of parsed) {
    if (!file.startsWith('src/')) continue
    const { ast, lineAt } = entry
    const isParseBody = (n, parent) => {
      if (n.type !== 'ArrowFunctionExpression' && n.type !== 'FunctionExpression'
        && n.type !== 'FunctionDeclaration') return false
      const named = (n.id && n.id.name === 'parse')
        || (parent && parent.key && parent.key.name === 'parse'
          && (parent.type === 'ObjectProperty' || parent.type === 'Property'
            || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition'))
      if (named) return true
      const p = n.params ?? []
      const names = p.map((x) => (x.type === 'Identifier' ? x.name : null))
      return names.length >= 3 && (names[0] === 'input' || names[0] === '_input')
        && typeof names[2] === 'string' && /ctx/i.test(names[2])
    }
    const scan = (node, atLine, own) => {
      walkScoped(node, (n) => {
        if (n.type !== 'StaticMemberExpression' && n.type !== 'MemberExpression') return
        if (n.computed) return
        let obj = unwrap(n.object)
        while (obj && (obj.type === 'TSNonNullExpression' || obj.type === 'ChainExpression')) {
          obj = unwrap(obj.expression)
        }
        if (!obj || obj.type !== 'Identifier' || !OPTION_BASES.has(obj.name)) return
        if (own.has(obj.name)) return
        const f = n.property?.name ?? '?'
        report('INV-7', file, lineAt(n.start),
          `parse body (opened at line ${atLine}) reads the construction-time option \`${obj.name}.${f}\` — `
          + 'that answer is fixed when the combinator is built; resolve it there and SELECT a pre-written '
          + 'variant, the way `parser()` selects its trackLines resolver',
          `INV-7:${file}:${obj.name}.${f}:${atLine}`)
      })
    }
    const visit = (n, parent) => {
      if (n === null || typeof n !== 'object') return
      if (Array.isArray(n)) { for (const c of n) visit(c, parent); return }
      if (typeof n.type !== 'string') { for (const k in n) visit(n[k], parent); return }
      if (isParseBody(n, parent)) scan(n.body, lineAt(n.start), paramNames(n))
      for (const k in n) { if (k === 'type') continue; visit(n[k], n) }
    }
    visit(ast, null)
  }
}

/* ================================================================== *
 * INV-8 — no exported NAME may resolve to two different declarations.
 *
 * DECIDES: for every VALUE exported from any module under src/, follow the
 * export graph — re-export specifiers, `export … as …`, and `export *` — to the
 * declaration it originates at. A name whose origins across src/ number more
 * than one is the finding. A barrel that re-exports one declaration under one
 * name resolves to a single origin and is silent, which is what makes this rule
 * usable at all: this codebase is mostly barrels.
 *
 * WHY THIS EXACT SHAPE: `tableRules` named two different ENGINES depending on
 * which module you imported it from — `src/table/exec.ts`'s own declaration (the
 * reference interpreter) and `src/table/index.ts`'s alias for `assembledRules`
 * (the shipped assembler). Three call sites picked one or the other by accident.
 * It type-checked either way, because both are `Record<string, TableRule>`, so
 * neither the compiler nor the linter nor a reviewer's eye could tell them
 * apart. The type system cannot see this. The export graph can.
 *
 * The failure is not "two functions are similar". It is that a reader who finds
 * one has no way to learn the other exists, and a reviewer reading a call site
 * cannot tell which one it got. That makes drift between them undetectable by
 * construction, which is how all five of this project's duplicate-definition
 * defects survived for months.
 *
 * TYPES ARE EXCLUDED, deliberately. A type alias re-declared under one name in
 * two modules is a real smell, but structural typing makes the two
 * interchangeable wherever they agree, so the finding is not decidable as
 * "these mean different things" — it needs a judgement call, and a rule that
 * needs one fires on innocent code and gets switched off.
 *
 * FALSE-POSITIVE FLOOR: zero heuristics and no similarity threshold. A finding
 * means two declarations exist, both exported, under one name. If that is
 * deliberate — `run` is, and says so at both sites — it goes in ALLOW with the
 * argument written down, which is strictly better than the argument existing
 * only in someone's head.
 * ================================================================== */
{
  /** A relative specifier resolved to a parsed src/ module, or null. */
  const resolveSpec = (from, spec) => {
    if (typeof spec !== 'string' || !spec.startsWith('.')) return null
    const t = relative(ROOT, resolve(ROOT, dirname(from), spec))
    if (parsed.has(t)) return t
    const asTs = t.replace(/\.js$/, '.ts')
    if (parsed.has(asTs)) return asTs
    if (parsed.has(join(t, 'index.ts'))) return join(t, 'index.ts')
    return null
  }

  /** file -> Map<exportedName, entry>; and file -> `export *` targets. */
  const exportsOf = new Map()
  const starsOf = new Map()
  for (const [file, { ast, lineAt }] of parsed) {
    const m = new Map()
    const stars = []
    exportsOf.set(file, m)
    starsOf.set(file, stars)
    for (const stmt of ast.body ?? []) {
      if (stmt.type === 'ExportAllDeclaration') {
        // `export * from` re-exports VALUES unless the statement is type-only.
        if (stmt.exportKind !== 'type') { const t = resolveSpec(file, stmt.source?.value); if (t) stars.push(t) }
        continue
      }
      if (stmt.type !== 'ExportNamedDeclaration') continue
      const d = stmt.declaration
      if (d) {
        if (d.type === 'TSTypeAliasDeclaration' || d.type === 'TSInterfaceDeclaration') continue
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
          m.set(d.id.name, { kind: 'decl', line: lineAt(d.start) })
        } else if (d.type === 'VariableDeclaration') {
          for (const v of d.declarations) if (v.id?.type === 'Identifier') m.set(v.id.name, { kind: 'decl', line: lineAt(v.start) })
        }
        continue
      }
      if (stmt.exportKind === 'type' || !stmt.specifiers) continue
      for (const s of stmt.specifiers) {
        if (s.exportKind === 'type') continue
        const exported = s.exported?.name ?? s.exported?.value
        const local = s.local?.name ?? s.local?.value
        if (!exported) continue
        // No `from` clause: the local binding was imported into THIS module, so
        // the origin is wherever that import came from. Recorded as a hop through
        // this file's own import table, resolved below.
        const target = stmt.source ? resolveSpec(file, stmt.source.value) : file
        m.set(exported, target
          ? { kind: 'from', target, local, line: lineAt(s.start) }
          // An unresolvable specifier (a bare package, `node:` builtin) is not a
          // src/ declaration and cannot collide with one — treat it as its own
          // origin so it never groups with anything.
          : { kind: 'decl', line: lineAt(s.start) })
      }
    }
  }

  /** file -> Map<localName, {target, imported}> for `export { x }` with no `from`. */
  const importsOf = new Map()
  for (const [file, { ast }] of parsed) {
    const m = new Map()
    importsOf.set(file, m)
    for (const stmt of ast.body ?? []) {
      if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue
      const target = resolveSpec(file, stmt.source?.value)
      if (!target) continue
      for (const s of stmt.specifiers ?? []) {
        if (s.importKind === 'type') continue
        if (s.type !== 'ImportSpecifier') continue
        const local = s.local?.name
        const imported = s.imported?.name ?? s.imported?.value
        if (local && imported) m.set(local, { target, imported })
      }
    }
  }

  /** The `file#name` this export originates at, following every hop. */
  const originOf = (file, name, seen = new Set()) => {
    const key = `${file}#${name}`
    if (seen.has(key)) return null
    seen.add(key)
    const e = exportsOf.get(file)?.get(name)
    if (e) {
      if (e.kind === 'decl') return key
      if (e.target !== file) return originOf(e.target, e.local, seen) ?? `${e.target}#${e.local}`
      // Re-export of a local binding: hop through this module's imports.
      const imp = importsOf.get(file)?.get(e.local)
      if (imp) return originOf(imp.target, imp.imported, seen) ?? `${imp.target}#${imp.imported}`
      return `${file}#${e.local}`
    }
    for (const t of starsOf.get(file) ?? []) { const r = originOf(t, name, seen); if (r) return r }
    return null
  }

  /** name -> origin -> the export sites that reach it */
  const byName = new Map()
  for (const [file, m] of exportsOf) {
    for (const [name, e] of m) {
      const o = originOf(file, name)
      if (!o) continue
      if (!byName.has(name)) byName.set(name, new Map())
      const groups = byName.get(name)
      if (!groups.has(o)) groups.set(o, [])
      groups.get(o).push(`${file}:${e.line}`)
    }
  }
  for (const [name, groups] of byName) {
    if (groups.size < 2) continue
    const origins = [...groups.keys()].sort()
    const detail = origins.map((o) => `${o} (exported at ${groups.get(o).join(', ')})`).join('  vs  ')
    const first = origins[0].split('#')[0]
    report('INV-8', first, exportsOf.get(first)?.get(name)?.line ?? 1,
      `\`${name}\` is exported from src/ but resolves to ${groups.size} DIFFERENT declarations — ${detail}. `
      + 'One name, one definition: a reader who finds one has no way to learn the other exists, and a call site gives no clue which it got. '
      + 'Collapse them, or rename one so the difference is visible at every use',
      `INV-8:${name}:${origins.join('|')}`)
  }
}

/* ================================================================== *
 * INV-9 — no cross-module KEY string may be minted in more than one module.
 *
 * DECIDES: a `Symbol(<string literal>)` or `Symbol.for(<string literal>)` whose
 * literal appears in a second module under src/.
 *
 * WHY THIS EXACT SHAPE, and why the two spellings are different defects:
 *
 *   Symbol(d)      mints a FRESH symbol per call. Two modules that each write
 *                  `Symbol('pm.fail')` hold two symbols that are not equal, so
 *                  a property one stores is invisible to the other. `pm.fail`
 *                  was minted in `src/table/exec.ts` and `src/table/assemble.ts`
 *                  and was safe only because the `TableRule` ABI converted both
 *                  before they crossed — an accident of the boundary, not a
 *                  design. Nothing said so, and nothing checked.
 *   Symbol.for(d)  resolves through the global registry, so the two ARE equal
 *                  and the code works. The defect is the DUPLICATED KEY: the
 *                  string is the contract, and renaming it at one site silently
 *                  disconnects the other. There is no type error and no test
 *                  failure — the property simply stops being found. That is the
 *                  shape carried on the shipped macro path today between
 *                  `src/compiler/linker.ts` and `src/plugin/index.ts`.
 *
 * Both are the same rule: a key that two modules must agree on has one owner,
 * exports it, and the second module imports it. The fix is always an import.
 *
 * FALSE-POSITIVE FLOOR: string literals only — a computed description is not
 * decidable and is not reported. Repeats WITHIN one module are not reported
 * either; a module is free to spell its own key twice, since a rename there
 * cannot desynchronise anything.
 * ================================================================== */
{
  /** literal -> { file, line, viaFor }[] */
  const minted = new Map()
  for (const [file, { ast, lineAt }] of parsed) {
    walk(ast, (n) => {
      if (n.type !== 'CallExpression') return
      const c = n.callee
      const plain = c?.type === 'Identifier' && c.name === 'Symbol'
      const viaFor = (c?.type === 'MemberExpression' || c?.type === 'StaticMemberExpression')
        && !c.computed && isId(c.object, 'Symbol') && c.property?.name === 'for'
      if (!plain && !viaFor) return
      const a = n.arguments?.[0]
      if (!a || a.type !== 'Literal' || typeof a.value !== 'string') return
      if (!minted.has(a.value)) minted.set(a.value, [])
      minted.get(a.value).push({ file, line: lineAt(n.start), viaFor })
    })
  }
  for (const [desc, sites] of minted) {
    const distinct = [...new Set(sites.map((s) => s.file))].sort()
    if (distinct.length < 2) continue
    const where = sites.map((s) => `${s.file}:${s.line}`).join(' , ')
    const anyPlain = sites.some((s) => !s.viaFor)
    report('INV-9', sites[0].file, sites[0].line,
      `the key \`${desc}\` is minted in ${distinct.length} modules — ${where}. `
      + (anyPlain
        ? '`Symbol()` mints a FRESH symbol per call, so these are NOT equal and a property one stores is invisible to the other. '
        : '`Symbol.for()` makes these equal today, but the STRING is the contract: renaming it at one site silently disconnects the other, with no type error and no failing test. ')
      + 'Give the key one owner, export it, and import it at the other site',
      `INV-9:${desc}`)
  }
}

/* ================================================================== *
 * INV-10 — no comment may name a repo path that does not exist.
 *
 * DECIDES: a `src/…`, `bench/…`, `test/…`, `scripts/…`, `docs/…` or `examples/…`
 * path with a source or doc extension, appearing anywhere in a comment, that is
 * not a file on disk.
 *
 * WHY: `bench/jess/fixture.ts` printed a column called `codegen` for a compiler
 * module of that name, which was deleted in `37c57b5`. The header comment
 * describing what that column measured is WHY the mislabel survived: the label
 * documented an intent, the intent outlived the code, and two separate lanes
 * read the stale name and drew conclusions from it. A comment that can go stale
 * silently is worse than no comment, because it actively misleads the next
 * reader — and unlike code, nothing ever executes it.
 *
 * This rule does not check that prose is TRUE. Nothing can. It checks the one
 * part of prose that is mechanically decidable — whether the code it points at
 * still exists — which is exactly the part that rots on someone else's commit
 * rather than on the author's.
 *
 * SCOPE is wider than the other rules deliberately: comments in `bench/`,
 * `test/` and `scripts/` rot the same way and the fixture defect was in
 * `bench/`. Only comments are read from those trees; nothing else about them is
 * analysed, so this does not change what INV-2/3/4 mean.
 *
 * FALSE-POSITIVE FLOOR: the path must carry a real extension and sit under a
 * known top-level directory, so ordinary prose cannot trip it. A deleted file
 * that prose should still mention — a historical reference — takes an ALLOW
 * entry stating that, which is the correct outcome: the reference stops being a
 * silent lie and becomes a stated one.
 * ================================================================== */
{
  const PROSE_ROOTS = ['src', 'bench', 'test', 'scripts', 'docs', 'examples']
  // Extensions are matched LONGEST-FIRST and must not be followed by another
  // identifier character: `js` before `json` would match `coverage-baseline.json`
  // as `coverage-baseline.js` and report a file that exists as missing.
  const PATH_RE = /(?:^|[\s`'"(\[<])((?:src|bench|test|scripts|docs|examples)\/[A-Za-z0-9_@./-]*\.(?:tsx|ts|mjs|cjs|pegjs|jsonc|json|js|mts|cts|md|ne))(?![A-Za-z0-9])/g
  /** Comment text from every tree that carries prose about this codebase. */
  const commentFiles = []
  for (const f of files) commentFiles.push([f, parsed.get(f).comments, parsed.get(f).lineAt])
  for (const top of PROSE_ROOTS) {
    if (top === 'src') continue
    const dir = join(ROOT, top)
    if (!existsSync(dir)) continue
    const walkDir = (d) => {
      for (const name of readdirSync(d).sort()) {
        if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue
        // `test/fixtures/` holds DELIBERATELY broken trees — including this rule's
        // own planted violation, which names a module that must not exist. Scanning
        // them would make every fixture a finding in the repo that owns it.
        if (name === 'fixtures') continue
        // The allowlist is the LEDGER OF EXEMPTIONS. Its entries name findings,
        // and ten of them exist precisely because a path is gone — so the prose
        // explaining them names deleted files by necessity. Scanning it would
        // make every INV-10 exemption generate the finding it exempts.
        if (name === 'invariant-allowlist.mjs') continue
        const p = join(d, name)
        if (statSync(p).isDirectory()) { walkDir(p); continue }
        if (!/\.(ts|mjs)$/.test(name) || name.endsWith('.d.ts')) continue
        const rel = relative(ROOT, p)
        const code = readFileSync(p, 'utf8')
        let r
        try { r = parseSync(rel, code, { lang: 'ts' }) } catch { continue }
        const starts = [0]
        for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1)
        const lineAt = (idx) => {
          let lo = 0, hi = starts.length - 1
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1 }
          return lo + 1
        }
        commentFiles.push([rel, r.comments ?? [], lineAt])
      }
    }
    walkDir(dir)
  }
  for (const [file, comments, lineAt] of commentFiles) {
    for (const c of comments) {
      const text = c.value ?? ''
      for (const m of text.matchAll(PATH_RE)) {
        const p = m[1]
        if (existsSync(join(ROOT, p))) continue
        report('INV-10', file, lineAt(c.start),
          `a comment names \`${p}\`, which does not exist. Prose that points at deleted code does not fail — it misleads, `
          + 'and it keeps naming an intent the code no longer has. Update the reference, or delete the sentence that needs it',
          `INV-10:${file}:${p}`)
      }
    }
  }
}

/* ================================================================== *
 * Report.
 * ================================================================== */
const listOnly = process.argv.includes('--list')
const asJson = process.argv.includes('--json')
findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)

const isAllowed = (f) => USE_ALLOW && ALLOW.has(f.key)
const allowed = findings.filter(isAllowed)
const live = findings.filter((f) => !isAllowed(f))
const staleAllow = USE_ALLOW ? [...ALLOW.keys()].filter((k) => !findings.some((f) => f.key === k)) : []

/** Every DEBT entry, restated on every run. Debt nobody says out loud is debt
 *  nobody pays: these are the entries that carry a promise to do work, and the
 *  gate going green is the only moment anyone is reliably looking at it. */
const debt = [...ALLOW].filter(([, e]) => e.category === 'DEBT')

if (asJson) {
  console.log(JSON.stringify({
    live,
    allowed: allowed.map((f) => f.key),
    staleAllow,
    allowCount: ALLOW.size,
    debt: debt.map(([key, e]) => ({ key, why: e.why, ref: e.ref })),
  }, null, 2))
} else {
  for (const f of live) console.log(`${f.rule}  ${f.file}:${f.line}\n    ${f.message}\n`)
  if (allowed.length) {
    // One line per allowlist ENTRY, with its category and the site count it
    // covers — several sites can share one entry (six `delete ctx._triviaLog`
    // calls in one function are one exemption, not six).
    const byKey = new Map()
    for (const f of allowed) byKey.set(f.key, (byKey.get(f.key) ?? 0) + 1)
    console.log(`${byKey.size} allowlisted pre-existing entr${byKey.size === 1 ? 'y' : 'ies'} covering ${allowed.length} site${allowed.length === 1 ? '' : 's'}:`)
    for (const [k, n] of byKey) console.log(`  [${ALLOW.get(k).category}] ${k}${n > 1 ? `  (x${n})` : ''}`)
  }
  if (debt.length) {
    console.log(`\n${debt.length} outstanding DEBT entr${debt.length === 1 ? 'y' : 'ies'} — these are owed, not accepted:`)
    for (const [key, e] of debt) console.log(`  ${key}  →  ${e.ref}`)
  }
  console.log(`\ninvariant gate: ${files.length} modules examined, ${live.length} finding${live.length === 1 ? '' : 's'}`)
}

// A stale allowlist entry is a FAILURE, not a shrug: it means the violation is
// gone and the exemption is now a standing licence to reintroduce it. The list
// may only get shorter, and this is what makes that mechanical rather than
// aspirational.
if (staleAllow.length && !listOnly) {
  console.error(`\ninvariant gate: allowlist entries no longer match any finding — DELETE them:\n  ${staleAllow.join('\n  ')}`)
  process.exit(1)
}
if (live.length && !listOnly) process.exit(1)
