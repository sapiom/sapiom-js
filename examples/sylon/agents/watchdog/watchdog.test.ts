/** watchdog: pure rules, then the tick against a stubbed API and an in-memory database. */
import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { setConfig } from "../../_shared/config";
import { memoryDb, type Db } from "../../_shared/db";
import { fakeCtx } from "../../_shared/test-ctx";
import { agent, requireKey, tick, type Deps } from "./index";
import {
  actionItems,
  failureMessage,
  FIRST_LOOKBACK_MS,
  lookbackFrom,
  MAX_POSTS,
  newFailures,
  OVERLAP_MS,
  splitBatch,
  type Execution,
} from "./logic";

const exec = (id: string, extra: Partial<Execution> = {}): Execution => ({
  id,
  definitionId: "def-copilot",
  status: "failed",
  startedAt: `2026-10-02T10:00:${id.padStart(2, "0").slice(-2)}Z`,
  finishedAt: `2026-10-02T10:01:${id.padStart(2, "0").slice(-2)}Z`,
  ...extra,
});

describe("actionItems", () => {
  const has = (items: string[], re: RegExp) => items.some((i) => re.test(i));

  it("reconnects Linear on an auth or scope error from the relay", () => {
    const items = actionItems(
      "sylon-escalation",
      "escalate",
      "linear MCP relay 401 unauthorized",
    );
    expect(has(items, /Reconnect Linear in Connectors/)).toBe(true);
    expect(has(items, /Replay/)).toBe(true);
  });

  it.each(["not_in_channel", "channel_not_found"])(
    "invites the bot on %s",
    (code) => {
      const items = actionItems(
        "sylon-intake",
        "classify",
        `slack chat.postMessage failed (200): ${code}`,
      );
      expect(has(items, /invite the Slack bot/)).toBe(true);
    },
  );

  it.each(["missing_scope", "invalid_auth"])(
    "reconnects Slack on %s",
    (code) => {
      const items = actionItems("sylon-intake", "classify", `slack: ${code}`);
      expect(has(items, /reconnect Slack/)).toBe(true);
      expect(has(items, /Reconnect Linear/)).toBe(false);
    },
  );

  it("tells the team to reply by hand when the copilot has no draft", () => {
    const items = actionItems(
      "sylon-copilot",
      "draft",
      "copilot: no structured draft in the model output",
    );
    expect(has(items, /Reply to the customer by hand/)).toBe(true);
    expect(has(items, /SAP-3726/)).toBe(true);
  });

  it("points a missing config key at setup", () => {
    const items = actionItems(
      "sylon-controller",
      "scan",
      "MissingConfigError: config key 'nudge.minutes' is not set in the sylon database",
    );
    expect(has(items, /pnpm run setup/)).toBe(true);
    expect(has(items, /Postgres/)).toBe(false);
  });

  it("checks the database on a connection or schema error", () => {
    const items = actionItems(
      "sylon-intake",
      "classify",
      'relation "issues" does not exist',
    );
    expect(has(items, /Postgres/)).toBe(true);
  });

  it.each(["decisions evaluate failed (429)", "upstream 503 bad gateway"])(
    "calls %s transient",
    (error) => {
      const items = actionItems("sylon-controller", "scan", error);
      expect(has(items, /transient/)).toBe(true);
      expect(has(items, /Replay/)).toBe(true);
    },
  );

  it("falls back to the step log and a replay", () => {
    const items = actionItems("sylon-intake", "classify", "boom");
    expect(items).toEqual([
      "Open the run and read the classify step log.",
      "Fix the cause named in the error.",
      "Replay the run from the Events page once it is fixed.",
    ]);
  });
});

describe("failure selection", () => {
  it("skips reported ids, the watchdog's own run and duplicates, oldest first", () => {
    const rows = [exec("5"), exec("3"), exec("3"), exec("4"), exec("9")];
    const out = newFailures(rows, new Set(["4"]), "9");
    expect(out.map((r) => r.id)).toEqual(["3", "5"]);
  });

  it("posts at most MAX_POSTS and counts the rest", () => {
    const rows = Array.from({ length: MAX_POSTS + 3 }, (_, i) =>
      exec(String(i + 10)),
    );
    const { post, more } = splitBatch(rows);
    expect(post).toHaveLength(MAX_POSTS);
    expect(more).toHaveLength(3);
  });

  it("looks back an hour on the first run, then from the cursor minus the overlap", () => {
    const now = new Date("2026-10-02T12:00:00Z");
    expect(lookbackFrom(null, now).getTime()).toBe(
      now.getTime() - FIRST_LOOKBACK_MS,
    );
    const cursor = new Date("2026-10-02T11:55:00Z");
    expect(lookbackFrom(cursor, now).getTime()).toBe(
      cursor.getTime() - OVERLAP_MS,
    );
  });
});

describe("failureMessage", () => {
  it("escapes and truncates the error and links the failed run", () => {
    const { text, blocks } = failureMessage({
      executionId: "e1",
      slug: "sylon-copilot",
      definitionId: "def-copilot",
      step: "draft",
      attempt: 2,
      error: `<!channel> ${"x".repeat(500)}`,
      faultClass: null,
      startedAt: "2026-10-02T10:00:00.000Z",
      finishedAt: "2026-10-02T10:01:00.000Z",
      issueNumber: 42,
    });
    const body = JSON.stringify(blocks);
    expect(text).toContain("sylon-copilot failed at draft (attempt 2)");
    expect(body).not.toContain("<!channel>");
    expect(body).not.toContain("x".repeat(301));
    expect(body).toContain("https://app.sapiom.ai/agents/def-copilot/runs/e1");
    expect(body).toContain("Issue: #42");
    expect(body).toContain("Action items");
  });
});

// --- the tick ----------------------------------------------------------------------------------

type Handler = (url: URL) => unknown;

function stubFetch(handler: Handler) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const body = handler(url);
    if (body instanceof Error)
      return new Response(body.message, { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const DEFS = [
  { id: "def-copilot", slug: "sylon-copilot" },
  { id: "def-watchdog", slug: "sylon-watchdog" },
  { id: "def-smoke", slug: "sylon-smoke-ingest" },
];

function api(failed: Execution[]) {
  return stubFetch((url) => {
    if (url.pathname === "/v1/workflows/definitions") return DEFS;
    if (url.pathname === "/v1/workflows/executions")
      return url.searchParams.get("definitionId") === "def-copilot"
        ? failed
        : [];
    const id = url.pathname.split("/").pop()!;
    return {
      ...failed.find((f) => f.id === id),
      error: `copilot: no structured draft (${id})`,
      steps: [{ name: "draft", attempt: 1, status: "failed", error: "x" }],
    };
  });
}

const posts = (logs: { msg: string; data?: unknown }[]) =>
  logs
    .filter((l) => l.msg.startsWith("slack chat.postMessage"))
    .map((l) => (l.data as { args: { channel: string; text: string } }).args);

describe("tick", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await setConfig(db, "channels.triage", "C0TRIAGE001", "test");
  });
  const run = (fetch: Deps["fetch"], executionId = "wd-1") => {
    const c = fakeCtx({ isLocalTrace: true, executionId });
    return { ...c, done: tick(c.ctx, db, { fetch, apiKey: "k" }) };
  };

  it("posts once per failure to the triage channel, then nothing on the next tick", async () => {
    const { fetch, calls } = api([exec("11"), exec("12")]);
    const first = run(fetch);
    const out = await first.done;
    expect(out.posted).toEqual(["11", "12"]);
    expect(posts(first.logs).map((p) => p.channel)).toEqual([
      "C0TRIAGE001",
      "C0TRIAGE001",
    ]);
    expect(posts(first.logs)[0].text).toContain(
      "sylon-copilot failed at draft",
    );
    // Only the watched definitions are polled: not itself, not the smoke agents.
    expect(
      calls.filter((c) => c.startsWith("/v1/workflows/executions?")),
    ).toHaveLength(1);

    const second = run(fetch, "wd-2");
    expect((await second.done).posted).toEqual([]);
    expect(posts(second.logs)).toEqual([]);
  });

  it("uses alerts.channel when set", async () => {
    await setConfig(db, "alerts.channel", "C0ALERTS01", "test");
    const r = run(api([exec("11")]).fetch);
    await r.done;
    expect(posts(r.logs)[0].channel).toBe("C0ALERTS01");
  });

  it("looks back one hour first, then from the stored cursor", async () => {
    const { fetch, calls } = api([]);
    await run(fetch).done;
    const first = new URL(
      `https://x${calls.find((c) => c.includes("/executions?"))}`,
    );
    const span =
      Date.parse(first.searchParams.get("to")!) -
      Date.parse(first.searchParams.get("from")!);
    expect(span).toBe(FIRST_LOOKBACK_MS);
    expect(first.searchParams.get("status")).toBe("failed");

    const stored = await db.query<{ cursor: Date }>(
      "select cursor from watchdog_state",
    );
    expect(stored).toHaveLength(1);
  });

  it("posts 10 and one 'and N more' line, and records the rest", async () => {
    const rows = Array.from({ length: 13 }, (_, i) => exec(String(i + 10)));
    const r = run(api(rows).fetch);
    const out = await r.done;
    const sent = posts(r.logs);
    expect(out.posted).toHaveLength(10);
    expect(sent).toHaveLength(11);
    expect(sent[10].text).toContain("and 3 more failed runs");
    const left = await db.query("select * from watchdog_reported");
    expect(left).toHaveLength(13);
  });

  it("never reports its own execution", async () => {
    const r = run(api([exec("wd-1")]).fetch, "wd-1");
    expect((await r.done).posted).toEqual([]);
    expect(posts(r.logs)).toEqual([]);
  });

  it("posts from the list row when the detail call fails", async () => {
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/v1/workflows/definitions") return DEFS;
      if (url.pathname === "/v1/workflows/executions")
        return url.searchParams.get("definitionId") === "def-copilot"
          ? [exec("11", { currentStep: "draft" })]
          : [];
      return new Error("boom");
    });
    const r = run(fetch);
    await r.done;
    expect(posts(r.logs)[0].text).toContain("failed at draft");
  });

  it("throws and keeps the cursor when a list call fails, reporting nothing twice later", async () => {
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/v1/workflows/definitions") return DEFS;
      return new Error("down");
    });
    await expect(run(fetch).done).rejects.toThrow(/tick incomplete/);
    expect(await db.query("select * from watchdog_state")).toEqual([]);
  });

  it("names the linked issue from the runs table", async () => {
    await db.query(
      "insert into accounts (name, slack_channel_id) values ('A', 'C1')",
    );
    await db.query(
      `insert into issues (account_id, source, status)
       select id, 'slack', 'new' from accounts limit 1`,
    );
    await db.query(
      `insert into runs (execution_id, issue_id, agent)
       select '11', id, 'sylon-copilot' from issues limit 1`,
    );
    const [{ number }] = await db.query<{ number: number }>(
      "select number from issues",
    );
    const r = run(api([exec("11")]).fetch);
    await r.done;
    expect(
      r.logs.some((l) => JSON.stringify(l.data).includes(`#${number}`)),
    ).toBe(true);
  });
});

describe("watchdog step", () => {
  it("does not poll on a local trace", async () => {
    const { ctx } = fakeCtx({ isLocalTrace: true });
    const step = agent.steps.scan as unknown as {
      run: (i: unknown, c: unknown) => Promise<{ output?: unknown }>;
    };
    const done = await step.run(fixture("watchdog/cron.json").payload, ctx);
    expect(done.output).toEqual({ outcome: "local_trace" });
  });
});

describe("requireKey", () => {
  it("returns the injected key", () => {
    expect(requireKey({ SYLON_WATCHDOG_API_KEY: "k" })).toBe("k");
  });

  it("tells the operator to run setup when the secret is missing", () => {
    expect(() => requireKey({})).toThrow(/pnpm run setup --only watchdog/);
  });
});
