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

  it("lists no MCP tools and, like the relay, answers callTool with an unavailable-tool error by default", async () => {
    const client = createStubClient();
    const unavailable = {
      content: [{ type: "text", text: "That tool is not available." }],
      isError: true,
    };

    await expect(client.connectors.linear.listTools()).resolves.toEqual([]);
    await expect(
      client.connectors.notion.callTool("search", { query: "q" }),
    ).resolves.toEqual(unavailable);
    await expect(
      client.connectors.mcp("acme-crm").callTool("lookup"),
    ).resolves.toEqual(unavailable);
  });

  it("succeeds for a tool the step discovered, even when the listTools override is stateful", async () => {
    const calls: StubCallRecord[] = [];
    let page = 0;
    const client = createStubClient({
      calls,
      overrides: {
        // A different list on every call: a hidden re-read would miss list_issues.
        "connectors.linear.listTools": () => [
          { name: page++ === 0 ? "list_issues" : "other", inputSchema: {} },
        ],
      },
    });

    const tools = await client.connectors.linear.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_issues"]);
    await expect(
      client.connectors.linear.callTool("list_issues", {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "stub result for linear.list_issues" }],
      isError: false,
    });
    await expect(
      client.connectors.linear.callTool("save_issue", {}),
    ).resolves.toMatchObject({ isError: true });
    // The override ran once, for the step's own listTools call.
    expect(page).toBe(1);
    expect(calls.map((c) => c.capability)).toEqual([
      "connectors.linear.listTools",
      "connectors.linear.callTool",
      "connectors.linear.callTool",
    ]);
  });

  it("returns isError for a listed tool the step never discovered", async () => {
    const client = createStubClient({
      overrides: {
        "connectors.linear.listTools": [
          { name: "list_issues", inputSchema: {} },
        ],
      },
    });
    await expect(
      client.connectors.linear.callTool("list_issues", {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "That tool is not available." }],
      isError: true,
    });
  });

  it("keeps discovery per slug and shares it across mcp(slug) handles", async () => {
    const client = createStubClient({
      overrides: {
        "connectors.mcp.listTools": [{ name: "search", inputSchema: {} }],
      },
    });
    await client.connectors.mcp("acme").listTools();

    await expect(
      client.connectors.mcp("acme").callTool("search"),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      client.connectors.notion.callTool("search"),
    ).resolves.toMatchObject({ isError: true });
  });

  it("marks a listTools override used only when the step calls listTools", async () => {
    const overrides = {
      "connectors.linear.listTools": [{ name: "list_issues", inputSchema: {} }],
    };

    const idle = new Set<string>();
    const a = createStubClient({ overrides, usedKeys: idle });
    await a.connectors.linear.callTool("list_issues");
    expect([...idle]).toEqual([]);

    const used = new Set<string>();
    const b = createStubClient({ overrides, usedKeys: used });
    await b.connectors.linear.listTools();
    await b.connectors.linear.callTool("list_issues");
    expect([...used]).toEqual(["connectors.linear.listTools"]);
  });

  it("warns on malformed Slack and MCP overrides", async () => {
    const warnings = new Set<string>();
    const client = createStubClient({
      warnings,
      overrides: {
        "connectors.slack.postMessage": "sent",
        "connectors.linear.listTools": { tools: [] },
        "connectors.notion.listTools": [{ title: "no name" }],
        "connectors.mcp.callTool": { text: "no content array" },
      },
    });

    await client.connectors.slack.postMessage({ channel: "C1", text: "x" });
    await expect(client.connectors.linear.listTools()).resolves.toEqual([]);
    await client.connectors.notion.listTools();
    await client.connectors.notion.callTool("search");

    const all = [...warnings];
    expect(all).toHaveLength(4);
    expect(all[0]).toMatch(
      /'connectors\.slack\.postMessage'.*Slack response object.*string/,
    );
    expect(all[1]).toMatch(
      /'connectors\.linear\.listTools'.*array of tools.*object/,
    );
    expect(all[2]).toMatch(/'connectors\.notion\.listTools'\[0\].*tool shape/);
    expect(all[3]).toMatch(/'connectors\.mcp\.callTool'.*CallToolResult/);
  });

  it("does not warn on well-formed overrides or defaults", async () => {
    const warnings = new Set<string>();
    const client = createStubClient({
      warnings,
      overrides: {
        "connectors.slack.userInfo": { ok: true, user: { id: "U1" } },
        "connectors.linear.listTools": [{ name: "t", inputSchema: {} }],
        "connectors.linear.callTool": { content: [] },
      },
    });

    await client.connectors.slack.userInfo({ user: "U1" });
    await client.connectors.slack.postMessage({ channel: "C1", text: "x" });
    await client.connectors.linear.listTools();
    await client.connectors.linear.callTool("t");
    await client.connectors.notion.listTools();
    await client.connectors.notion.callTool("x");
    expect([...warnings]).toEqual([]);
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
