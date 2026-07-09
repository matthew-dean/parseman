// Comment-dense A/B microbench: exercises the standalone-comment lift path
// (_liftStandaloneComments) far harder than the real corpus does. Run under the
// parseman macro-register so parseCssFn uses the compiled grammar.
import { parseCssFn } from './src/functional-parser.ts';

// Build a comment-dense sheet: many rules, each preceded by a standalone block
// comment, with inline comments inside, and nested rulesets with their own gaps.
function makeSheet(nRules: number): string {
  const parts: string[] = [];
  for (let i = 0; i < nRules; i++) {
    parts.push(`/* standalone comment number ${i} describing the rule below */`);
    parts.push(`.rule-${i} {`);
    parts.push(`  /* leading inline */ color: red;`);
    parts.push(`  width: ${i}px; /* trailing inline */`);
    parts.push(`  .nested-${i} {`);
    parts.push(`    /* nested standalone */`);
    parts.push(`    height: ${i}px;`);
    parts.push(`  }`);
    parts.push(`}`);
  }
  return parts.join('\n');
}

const src = makeSheet(400);
const commentCount = (src.match(/\/\*/g) ?? []).length;
console.log(`sheet: ${src.length} chars, ${commentCount} comments`);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

// warm up (JIT + macro compile)
for (let i = 0; i < 20; i++) parseCssFn(src);

const ITER = 120;
const times: number[] = [];
for (let i = 0; i < ITER; i++) {
  const t0 = performance.now();
  parseCssFn(src);
  times.push(performance.now() - t0);
}
// sanity: confirm comments were actually lifted
const res = parseCssFn(src);
console.log(`lifted comment ranges: ${res.liftedCommentRanges.length}`);
console.log(`median parse: ${median(times).toFixed(3)}ms over ${ITER} iters (min ${Math.min(...times).toFixed(3)})`);
