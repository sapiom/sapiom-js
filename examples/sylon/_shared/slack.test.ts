import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SlackMethodError,
  permalink,
  post,
  react,
  replies,
  update,
  userInfo,
} from "./slack";
import { fakeCtx } from "./test-ctx";

type Call = {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

function mockFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      });
      const r = responses.shift() ?? { body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

describe("slack.ts", () => {
  beforeEach(() => {
    vi.stubEnv("SAPIOM_API_KEY", "sat_test");
    vi.stubEnv("SAPIOM_TOOLS_BASE", "https://tools.example");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts through the connector method route with the run credential", async () => {
    const calls = mockFetch([{ body: { ok: true, channel: "C1", ts: "1.2" } }]);
    const { ctx } = fakeCtx();
    await expect(
      post(ctx as never, { channel: "C1", text: "hi", threadTs: "1.0" }),
    ).resolves.toEqual({ channel: "C1", ts: "1.2" });
    expect(calls[0].url).toBe(
      "https://tools.example/connectors/v1/slack/methods/chat.postMessage",
    );
    expect(calls[0].headers["x-sapiom-api-key"]).toBe("sat_test");
    expect(calls[0].body).toEqual({
      channel: "C1",
      text: "hi",
      threadTs: "1.0",
    });
  });

  it("maps the connector's arg names (timestamp for reactions)", async () => {
    const calls = mockFetch([{ body: { ok: true } }, { body: { ok: true } }]);
    const { ctx } = fakeCtx();
    await react(ctx as never, { channel: "C1", ts: "1.0", name: "eyes" });
    await update(ctx as never, { channel: "C1", ts: "1.0", text: "x" });
    expect(calls[0]).toMatchObject({
      url: expect.stringMatching(/reactions\.add$/),
      body: { channel: "C1", timestamp: "1.0", name: "eyes" },
    });
    expect(calls[1]).toMatchObject({
      url: expect.stringMatching(/chat\.update$/),
      body: { channel: "C1", ts: "1.0", text: "x" },
    });
  });

  it("throws a SlackMethodError with the connector's message", async () => {
    mockFetch([
      {
        status: 502,
        body: { message: "Slack chat.postMessage failed (channel_not_found)" },
      },
    ]);
    const { ctx } = fakeCtx();
    await expect(
      post(ctx as never, { channel: "C1", text: "hi" }),
    ).rejects.toBeInstanceOf(SlackMethodError);
  });

  it("never throws on a reaction failure", async () => {
    mockFetch([{ status: 502, body: { message: "already_reacted" } }]);
    const { ctx, logs } = fakeCtx();
    await expect(
      react(ctx as never, { channel: "C1", ts: "1.0", name: "eyes" }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("reads replies and a user's display name", async () => {
    mockFetch([
      {
        body: {
          ok: true,
          messages: [
            { ts: "1.0", text: "root" },
            { ts: "1.1", text: "reply" },
          ],
        },
      },
      {
        body: {
          ok: true,
          user: {
            id: "U1",
            name: "dave",
            profile: { display_name: "Dave", email: "d@x.io" },
          },
        },
      },
    ]);
    const { ctx } = fakeCtx();
    expect(
      (await replies(ctx as never, { channel: "C1", ts: "1.0" })).map(
        (m) => m.text,
      ),
    ).toEqual(["root", "reply"]);
    expect(await userInfo(ctx as never, "U1")).toEqual({
      id: "U1",
      name: "Dave",
      email: "d@x.io",
    });
  });

  it("sends nothing on a local trace", async () => {
    const calls = mockFetch([]);
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const out = await post(ctx as never, { channel: "C1", text: "hi" });
    expect(out.channel).toBe("C1");
    expect(out.ts).toMatch(/^\d+\.\d+$/);
    expect(calls).toEqual([]);
  });

  it("builds a permalink", () => {
    expect(permalink("C1", "1790889355.981329")).toBe(
      "https://slack.com/archives/C1/p1790889355981329",
    );
  });
});
