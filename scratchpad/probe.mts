import { balanced, node, rules, run } from '/Users/matthew/git/worktrees/parseman-review-scope/src/index.ts'
const g = rules<Record<string, any>>(() => ({ Doc: node('Doc', balanced('(', ')'), (c: any) => ({ t: 'Doc', c })) })) as any
for (const i of ['(a(b)c)', '([a)]', '(a', '(a"b)c")']) {
  const r = run(g.Doc, i, { recover: true } as never)
  console.log(JSON.stringify(i), 'ok', r.ok, 'errors', (r.errors ?? []).length, 'value', JSON.stringify((r.value as any)?.c?.[0]?.value), 'unconsumedFrom', r.unconsumedFrom)
}
