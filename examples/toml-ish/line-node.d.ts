/** Types for `line-node.js`. */
export declare const CommentLine: new () => { type: 'comment' }
export declare const SectionLine: new (name: string) => { type: 'section'; name: string }
export declare const EntryLine: new (key: string, value: string | number | boolean) => { type: 'entry'; key: string; value: string | number | boolean }
