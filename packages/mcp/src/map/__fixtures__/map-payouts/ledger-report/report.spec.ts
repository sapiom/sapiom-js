// Test files never become edges.
export async function fake(ctx: any) {
  await ctx.sapiom.agents.run({ definition: "award" });
}
