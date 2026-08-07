/**
 * Re-run the table behavior suites that exercise `tableRules()` with the
 * closure fallback selected before `assemble.ts` is loaded.
 *
 * These modules are also collected normally, where they test the default
 * emitted engine. Importing them here is intentional differential coverage of
 * the second maintained engine, not source-line padding: every assertion is the
 * same semantic contract against a different table implementation.
 */
import { vi } from 'vitest'

const prior = process.env.PM_TABLE_EMIT
process.env.PM_TABLE_EMIT = '0'
vi.resetModules()

await import('../parity/table-lowering-gaps.test.ts')
await import('../parity/table-recovery.test.ts')
await import('../parity/table-recovery-always.test.ts')
await import('../parity/rules-trivia.test.ts')
await import('../parity/trivia-kinds.test.ts')
await import('./compose-leaf-source-module.test.ts')
await import('./macro-transform.test.ts')
await import('./no-function-constructor.test.ts')
await import('./plugincov-index.test.ts')
await import('./shared-shape-external-ref.test.ts')
await import('./table-assemble.test.ts')
await import('./table-compile.test.ts')
await import('./table-compose-merge.test.ts')
await import('./table-coverage.test.ts')
await import('./table-driver-ops.test.ts')
await import('./table-emit-roundtrip.test.ts')
await import('./table-encode-refusals.test.ts')
await import('./table-entry-dist.test.ts')
await import('./table-identity.test.ts')
await import('./table-rule-map.test.ts')
await import('./table-track-lines.test.ts')

if (prior === undefined) delete process.env.PM_TABLE_EMIT
else process.env.PM_TABLE_EMIT = prior
