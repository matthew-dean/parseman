type Ctx = { keep: number, transient?: string }
export function step(ctx: Ctx): void {
  delete ctx.transient
}
