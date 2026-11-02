/**
 * The objects a parse keeps until it ends — spans, leaves, default nodes, field
 * captures, capture buffers — built by `new` calls instead of object literals.
 *
 * WHY. V8 keeps an allocation site per object literal and decides, per site, whether to
 * allocate straight into old space (pretenuring). The decision is taken during warm-up
 * from where scavenges happen to fall, so identical processes split into a fast and a
 * slow mode, and any change in bundle layout re-rolls it: on Node 26 a pretenured
 * process ran 34–61 mark-compacts per run where a fast one ran 1. A `new` call has no
 * allocation site, so these objects are never pretenured. Each constructor's
 * `prototype` is `Object.prototype`, so what it builds is a plain object: same
 * prototype, same `constructor`, same keys in the same order as the literal it replaces.
 *
 * ONE MODULE. Every constructor defines its own hidden class, so two copies of this
 * module build two maps for the same shape, and every site that reads both turns
 * polymorphic. The build therefore emits it once (`dist/cst/plain.js`) and every public
 * entry imports that file (`scripts/build.mjs`). The emitted engine receives the same
 * functions as factory parameters (`EMITTED_PARAMS`).
 */
import type { Span } from '../types.ts'
import type { CstCaptureBuf } from './capture-buffer.ts'

export type PlainLeafObject = { _tag: 'leaf'; value: unknown; span: Span }
export type PlainNodeObject = { _tag: 'node'; type: string; span: Span; state: unknown; children: unknown[] }
export type PlainFieldObject = { name: string; value: unknown; span: Span }

export declare const PlainSpan: new (start: number, end: number) => Span
export declare const PlainLeaf: new (value: unknown, span: Span) => PlainLeafObject
export type PlainLineSpanObject = { start: number; end: number; startLine: number; startColumn: number; endLine: number; endColumn: number }
export declare const PlainLineSpan: new (start: number, end: number, startLine: number, startColumn: number, endLine: number, endColumn: number) => PlainLineSpanObject
export declare const PlainTaggedNode: new (type: string, tags: readonly string[], span: Span, state: unknown, children: unknown[]) => { _tag: 'node'; type: string; tags: readonly string[]; span: Span; state: unknown; children: unknown[] }
export declare const PlainTriviaField: new (name: string, value: unknown, span: Span, leading: string, trailing: string) => { name: string; value: unknown; span: Span; leading: string; trailing: string }
/** A kept one- or two-item array, without an array literal's allocation site. */
export declare function plainList1<T>(a: T): T[]
export declare function plainList2<T>(a: T, b: T): T[]
export declare const PlainNode: new (type: string, span: Span, state: unknown, children: unknown[]) => PlainNodeObject
export declare const PlainField: new (name: string, value: unknown, span: Span) => PlainFieldObject
export declare const PlainBuf: new (rawOnly: true | undefined, noRaw: true | undefined, rawLen: number) => CstCaptureBuf
