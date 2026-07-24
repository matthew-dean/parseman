import { gate } from './gate.ts'

/**
 * @deprecated Renamed to `gate()` — the name now matches the `gate:` field on a
 * gated choice arm. This alias forwards to `gate()` unchanged and will be removed
 * in a future major. Update call sites: `guard(pred)` → `gate(pred)`.
 */
export const guard = gate
