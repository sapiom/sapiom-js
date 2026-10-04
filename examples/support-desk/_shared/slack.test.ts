import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SlackMethodError,
  callSlack,
  permalink,
  post,
  postEphemeral,
  react,
  replies,
  unreact,
  update,
  userInfo,
} from "./slack";
import { fakeCtx } from "./test-ctx";

type Call = { method: string; args: Record<string, unknown> };

/** A ctx whose `sapiom.connectors.slack` records calls and answers from `answers`. */
function ctxWithSlack(
  answers: Record<string, unknown> = {},
  fail?: { method: string; err: unknown },
) {
  const calls: Call[] = [];
  const method = (name: string) => async (args: Record<string, unknown>) => {
    calls.push({ method: name, args });
    if (fail?.method === name) throw fail.err;
    return answers[name] ?? { ok: true };
  };
  const slack = Object.fromEntries(
    [
      "postMessage",
      "update",
      "postEphemeral",
      "addReaction",
      "removeReaction",
      "replies",
      "userInfo",
    ].map((n) => [n, method(n)]),
  );
  const { ctx, logs } = fakeCtx();
  (ctx as { sapiom: unknown }).sapiom = { connectors: { slack } };
  return { ctx: ctx as never, calls, logs };
}

describe("slack.ts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts through ctx.sapiom.connectors.slack", async () => {
    const { ctx, calls } = ctxWithSlack({
      postMessage: { ok: true, channel: "C1", ts: "1.2" },
    });
    await expect(
      post(ctx, { channel: "C1", text: "hi", threadTs: "1.0" }),
    ).resolves.toEqual({ channel: "C1", ts: "1.2" });
    expect(calls).toEqual([
      {
        method: "postMessage",
        args: { channel: "C1", text: "hi", threadTs: "1.0" },
      },
    ]);
  });

  it("maps reactions to timestamp, and passes update and ephemeral through", async () => {
    const { ctx, calls } = ctxWithSlack();
    await react(ctx, { channel: "C1", ts: "1.0", name: "eyes" });
    await unreact(ctx, { channel: "C1", ts: "1.0", name: "eyes" });
    await update(ctx, { channel: "C1", ts: "1.0", text: "x" });
    await postEphemeral(ctx, {
      channel: "C1",
      user: "U1",
      text: "y",
      threadTs: "1.0",
    });
    expect(calls).toEqual([
      {
        method: "addReaction",
        args: { channel: "C1", timestamp: "1.0", name: "eyes" },
      },
      {
        method: "removeReaction",
        args: { channel: "C1", timestamp: "1.0", name: "eyes" },
      },
      { method: "update", args: { channel: "C1", ts: "1.0", text: "x" } },
      {
        method: "postEphemeral",
        args: { channel: "C1", user: "U1", text: "y", threadTs: "1.0" },
      },
    ]);
  });

  it("wraps a gateway error as a SlackMethodError carrying its message", async () => {
    const err = Object.assign(new Error("502"), {
      status: 502,
      body: { message: "Slack chat.postMessage failed (channel_not_found)" },
    });
    const { ctx } = ctxWithSlack({}, { method: "postMessage", err });
    const thrown = await post(ctx, { channel: "C1", text: "hi" }).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(SlackMethodError);
    expect(thrown).toMatchObject({
      status: 502,
      detail: expect.stringMatching(/channel_not_found/),
    });
  });

  it("never throws on a reaction failure", async () => {
    const { ctx, logs } = ctxWithSlack(
      {},
      { method: "addReaction", err: new Error("already_reacted") },
    );
    await expect(
      react(ctx, { channel: "C1", ts: "1.0", name: "eyes" }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("reads replies and a user's display name", async () => {
    const { ctx } = ctxWithSlack({
      replies: {
        ok: true,
        messages: [
          { ts: "1.0", text: "root" },
          { ts: "1.1", text: "reply" },
        ],
      },
      userInfo: {
        ok: true,
        user: {
          id: "U1",
          name: "pat",
          profile: { display_name: "Pat", email: "p@x.io" },
        },
      },
    });
    expect(
      (await replies(ctx, { channel: "C1", ts: "1.0" })).map((m) => m.text),
    ).toEqual(["root", "reply"]);
    expect(await userInfo(ctx, "U1")).toEqual({
      id: "U1",
      name: "Pat",
      email: "p@x.io",
    });
  });

  it("sends nothing on a local trace", async () => {
    const { ctx, calls } = ctxWithSlack();
    (ctx as { isLocalTrace: boolean }).isLocalTrace = true;
    const out = await post(ctx, { channel: "C1", text: "hi" });
    expect(out.channel).toBe("C1");
    expect(out.ts).toMatch(/^\d+\.\d+$/);
    expect(calls).toEqual([]);
  });

  it("callSlack reaches any connector method by name on the run credential", async () => {
    vi.stubEnv("SAPIOM_API_KEY", "sat_test");
    vi.stubEnv("SAPIOM_TOOLS_BASE", "https://tools.example");
    const seen: {
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body as string),
        });
        return new Response(JSON.stringify({ ok: true, x: 1 }), {
          status: 200,
        });
      }),
    );
    const { ctx } = fakeCtx();
    await expect(
      callSlack(ctx as never, "pins.add", { channel: "C1" }, () => ({})),
    ).resolves.toEqual({ ok: true, x: 1 });
    expect(seen[0]).toMatchObject({
      url: "https://tools.example/connectors/v1/slack/methods/pins.add",
      headers: { "x-sapiom-api-key": "sat_test" },
      body: { channel: "C1" },
    });
  });

  it("builds a permalink", () => {
    expect(permalink("C1", "1790889355.981329")).toBe(
      "https://slack.com/archives/C1/p1790889355981329",
    );
  });
});
