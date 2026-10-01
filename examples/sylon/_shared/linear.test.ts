import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LINEAR_TOOLS, createIssue, getIssue, parseMcpReply } from "./linear";
import { fakeCtx } from "./test-ctx";

function mockRelay(result: unknown) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
      return new Response(frame, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
  return bodies;
}

describe("linear.ts", () => {
  beforeEach(() => vi.stubEnv("SAPIOM_API_KEY", "sat_test"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("parses both JSON and SSE replies", () => {
    expect(parseMcpReply('{"result":{"a":1}}')).toEqual({ result: { a: 1 } });
    expect(
      parseMcpReply('event: message\ndata: {"result":{"a":2}}\n\n'),
    ).toEqual({ result: { a: 2 } });
  });

  it("creates an issue with save_issue and maps identifier/uuid", async () => {
    const bodies = mockRelay({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "SAP-42",
            uuid: "u-42",
            url: "https://linear.app/x/SAP-42",
          }),
        },
      ],
    });
    const { ctx } = fakeCtx();
    const out = await createIssue(ctx as never, {
      teamId: "team-1",
      title: "T",
      description: "D",
      projectId: "proj-1",
    });
    expect(out).toEqual({
      id: "u-42",
      identifier: "SAP-42",
      url: "https://linear.app/x/SAP-42",
      status: undefined,
      statusType: undefined,
    });
    expect(bodies[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: LINEAR_TOOLS.createIssue,
        arguments: {
          team: "team-1",
          title: "T",
          description: "D",
          project: "proj-1",
        },
      },
    });
  });

  it("surfaces a tool error", async () => {
    mockRelay({
      isError: true,
      content: [{ type: "text", text: "Team not found" }],
    });
    const { ctx } = fakeCtx();
    await expect(getIssue(ctx as never, "SAP-1")).rejects.toThrow(
      /Team not found/,
    );
  });

  it("sends nothing on a local trace", async () => {
    const bodies = mockRelay({});
    const { ctx } = fakeCtx({ isLocalTrace: true });
    expect(
      (
        await createIssue(ctx as never, {
          teamId: "t",
          title: "T",
          description: "D",
        })
      ).identifier,
    ).toBe("LOCAL-1");
    expect(bodies).toEqual([]);
  });
});
