import { describe, expect, it } from "vitest";

import {
  LINEAR_TOOLS,
  LinearRelayError,
  createIssue,
  getIssue,
  listTools,
} from "./linear";
import { fakeCtx } from "./test-ctx";

/** A ctx whose `sapiom.connectors.linear` answers every call with `result` (or throws `err`). */
function ctxWithLinear(result: unknown, err?: unknown) {
  const calls: { name: string; args: unknown }[] = [];
  const linear = {
    async listTools() {
      return [{ name: "save_issue", inputSchema: {} }];
    },
    async callTool(name: string, args: unknown) {
      calls.push({ name, args });
      if (err) throw err;
      return result;
    },
  };
  const { ctx } = fakeCtx();
  (ctx as { sapiom: unknown }).sapiom = { connectors: { linear } };
  return { ctx: ctx as never, calls };
}

const text = (o: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(o) }],
});

describe("linear.ts", () => {
  it("creates an issue with save_issue and maps identifier/uuid", async () => {
    const { ctx, calls } = ctxWithLinear(
      text({ id: "SAP-42", uuid: "u-42", url: "https://linear.app/x/SAP-42" }),
    );
    const out = await createIssue(ctx, {
      teamId: "team-1",
      title: "T",
      description: "D",
      projectId: "proj-1",
      priority: 2,
    });
    expect(out).toMatchObject({
      id: "u-42",
      identifier: "SAP-42",
      url: "https://linear.app/x/SAP-42",
    });
    expect(calls).toEqual([
      {
        name: LINEAR_TOOLS.createIssue,
        args: {
          team: "team-1",
          title: "T",
          description: "D",
          project: "proj-1",
          priority: 2,
        },
      },
    ]);
  });

  it("surfaces a tool error", async () => {
    const { ctx } = ctxWithLinear({
      isError: true,
      content: [{ type: "text", text: "Team not found" }],
    });
    await expect(getIssue(ctx, "SAP-1")).rejects.toThrow(/Team not found/);
  });

  it("wraps a relay failure as a LinearRelayError", async () => {
    const { ctx } = ctxWithLinear(undefined, new Error("relay unavailable"));
    await expect(getIssue(ctx, "SAP-1")).rejects.toBeInstanceOf(
      LinearRelayError,
    );
  });

  it("lists tools through the ctx connector", async () => {
    const { ctx } = ctxWithLinear(undefined);
    expect((await listTools(ctx)).map((t) => t.name)).toEqual(["save_issue"]);
  });

  it("sends nothing on a local trace", async () => {
    const { ctx, calls } = ctxWithLinear(text({}));
    (ctx as { isLocalTrace: boolean }).isLocalTrace = true;
    expect(
      (await createIssue(ctx, { teamId: "t", title: "T", description: "D" }))
        .identifier,
    ).toBe("LOCAL-1");
    expect(calls).toEqual([]);
  });
});
