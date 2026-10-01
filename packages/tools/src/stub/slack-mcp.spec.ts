import { createStubClient, type StubCallRecord } from "./index.js";

describe("stub slack + mcp connectors", () => {
  it("answers Slack methods offline with shape-faithful defaults", async () => {
    const client = createStubClient();
    const slack = client.connectors.slack;

    await expect(
      slack.postMessage({ channel: "C1", text: "hi" }),
    ).resolves.toEqual({ ok: true, channel: "C1", ts: "1700000000.000100" });
    await expect(
      slack.update({ channel: "C1", ts: "1.2", text: "edited" }),
    ).resolves.toEqual({ ok: true, channel: "C1", ts: "1.2", text: "edited" });
    await expect(
      slack.postEphemeral({ channel: "C1", user: "U1", text: "x" }),
    ).resolves.toEqual({ ok: true, message_ts: "1700000000.000200" });
    await expect(
      slack.addReaction({ channel: "C1", timestamp: "1.2", name: "eyes" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      slack.removeReaction({ channel: "C1", timestamp: "1.2", name: "eyes" }),
    ).resolves.toEqual({ ok: true });
    const thread = await slack.replies({ channel: "C1", ts: "1.1" });
    expect(thread.messages[0]).toMatchObject({ ts: "1.1" });
    const info = await slack.userInfo({ user: "U9" });
    expect(info.user).toMatchObject({ id: "U9", is_bot: false });
  });

  it("returns and records a Slack override", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({
      calls,
      overrides: {
        "connectors.slack.userInfo": ({ user }: { user: string }) => ({
          ok: true,
          user: { id: user, real_name: "Ada" },
        }),
      },
    });

    const info = await client.connectors.slack.userInfo({ user: "U1" });
    expect(info.user.real_name).toBe("Ada");
    expect(calls).toContainEqual(
      expect.objectContaining({
        capability: "connectors.slack.userInfo",
        args: [{ user: "U1" }],
      }),
    );
  });

  it("rejects when a Slack override throws", async () => {
    const client = createStubClient({
      overrides: {
        "connectors.slack.postMessage": () => {
          throw new Error("slack boom");
        },
      },
    });
    const pending = client.connectors.slack.postMessage({
      channel: "C1",
      text: "x",
    });
    await expect(pending).rejects.toThrow("slack boom");
  });

  it("lists no MCP tools and answers callTool with a text result by default", async () => {
    const client = createStubClient();

    await expect(client.connectors.linear.listTools()).resolves.toEqual([]);
    await expect(
      client.connectors.notion.callTool("search", { query: "q" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "stub result for notion.search" }],
      isError: false,
    });
    await expect(
      client.connectors.mcp("acme-crm").callTool("lookup"),
    ).resolves.toMatchObject({ isError: false });
  });

  it("prefers a per-slug MCP override over the connectors.mcp catch-all", async () => {
    const linearTools = [{ name: "list_issues", inputSchema: {} }];
    const client = createStubClient({
      overrides: {
        "connectors.linear.listTools": linearTools,
        "connectors.mcp.listTools": [],
        "connectors.mcp.callTool": (name: string) => ({
          content: [{ type: "text", text: `catch-all ${name}` }],
        }),
      },
    });

    await expect(client.connectors.linear.listTools()).resolves.toEqual(
      linearTools,
    );
    await expect(client.connectors.notion.listTools()).resolves.toEqual([]);
    await expect(
      client.connectors.linear.callTool("create_issue", { title: "t" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "catch-all create_issue" }],
    });
  });
});
