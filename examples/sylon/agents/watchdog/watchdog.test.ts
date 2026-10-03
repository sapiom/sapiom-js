/** watchdog: pure rules, then the tick against a stubbed API and an in-memory database. */
import { beforeEach, describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/index";
import { setConfig } from "../../_shared/config";
import { memoryDb, type Db } from "../../_shared/db";
import { upsertDesk } from "../../_shared/desks";
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
  describeFailure,
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
    expect(has(items, /copilot step logs/)).toBe(true);
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

  it("gives only the transient advice for a gateway 429", () => {
    const items = actionItems(
      "sylon-copilot",
      "draft",
      "POST https://llm.services.sapiom.ai/v2/anthropic/v1/messages → 429 rate limited",
    );
    expect(items.some((i) => /routing label/.test(i))).toBe(false);
    expect(items.filter((i) => /transient/.test(i))).toHaveLength(1);
  });

  it("still advises on a gateway 400", () => {
    const items = actionItems(
      "sylon-copilot",
      "draft",
      "POST https://llm.services.sapiom.ai/v2/anthropic/v1/messages → 400 bad model",
    );
    expect(items.some((i) => /routing label/.test(i))).toBe(true);
  });

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
    expect(text).toContain("sylon-copilot failed at draft (attempt 3)");
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

  it("prefers the default desk's triage channel to the legacy channels.triage", async () => {
    await upsertDesk(db, {
      slug: "support",
      name: "Support",
      triageChannel: "C0DESKTRI01",
      isDefault: true,
    });
    const r = run(api([exec("11")]).fetch);
    await r.done;
    expect(posts(r.logs)[0].channel).toBe("C0DESKTRI01");
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

describe("tick hardening", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await setConfig(db, "channels.triage", "C0TRIAGE001", "test");
  });
  const run = (fetch: Deps["fetch"], executionId = "wd-1") => {
    const c = fakeCtx({ isLocalTrace: true, executionId });
    return { ...c, done: tick(c.ctx, db, { fetch, apiKey: "k" }) };
  };
  /** Five rows a page and a four-page cap: the paging rules on a handful of rows. */
  const small = (fetch: Deps["fetch"]) => {
    const c = fakeCtx({ isLocalTrace: true, executionId: "wd-1" });
    return {
      ...c,
      done: tick(c.ctx, db, { fetch, apiKey: "k", page: 5, maxPages: 4 }),
    };
  };
  const denied = () => stubFetch(() => new Error("forbidden")).fetch;

  it("posts one deduped 'cannot poll' line when the key is rejected", async () => {
    const first = run(denied());
    await expect(first.done).rejects.toThrow();
    const sent = posts(first.logs);
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("C0TRIAGE001");
    expect(sent[0].text).toContain("Sylon watchdog cannot poll");
    expect(sent[0].text).toContain("pnpm run setup --only watchdog");

    const second = run(denied(), "wd-2");
    await expect(second.done).rejects.toThrow();
    expect(posts(second.logs)).toEqual([]);
  });

  it("alerts when a watched agent's list call fails, then throws", async () => {
    const { fetch } = stubFetch((url) =>
      url.pathname === "/v1/workflows/definitions" ? DEFS : new Error("down"),
    );
    const r = run(fetch);
    await expect(r.done).rejects.toThrow(/tick incomplete/);
    expect(posts(r.logs)[0].text).toContain("list sylon-copilot");
  });

  it("alerts again once the hour has passed", async () => {
    await expect(run(denied()).done).rejects.toThrow();
    await db.query(
      "update watchdog_alerted set alerted_at = now() - interval '2 hours'",
    );
    const again = run(denied(), "wd-2");
    await expect(again.done).rejects.toThrow();
    expect(posts(again.logs)).toHaveLength(1);
  });

  it("pages until a short page and keeps the cursor when the cap is hit", async () => {
    const full = Array.from({ length: 5 }, (_, i) => exec(String(1000 + i)));
    let pages = 0;
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/v1/workflows/definitions") return DEFS;
      if (url.pathname === "/v1/workflows/executions") {
        if (url.searchParams.get("definitionId") !== "def-copilot") return [];
        pages++;
        return full.map((f) => ({ ...f, id: `${f.id}-${pages}` }));
      }
      return {};
    });
    const out = await small(fetch).done;
    expect(pages).toBe(4);
    expect(out).toMatchObject({ incomplete: ["sylon-copilot"] });
    expect(await db.query("select * from watchdog_state")).toEqual([]);
  });

  it("reads every full page until a short one", async () => {
    let pages = 0;
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/v1/workflows/definitions") return DEFS;
      if (url.pathname === "/v1/workflows/executions") {
        if (url.searchParams.get("definitionId") !== "def-copilot") return [];
        pages++;
        return pages < 4
          ? Array.from({ length: 5 }, (_, i) => exec(`p${pages}-${i}`))
          : [];
      }
      return {};
    });
    const out = await small(fetch).done;
    expect(pages).toBe(4);
    expect(out).not.toHaveProperty("incomplete");
    expect(await db.query("select * from watchdog_state")).toHaveLength(1);
  });

  it("finds a run that started before the cursor and failed after it", async () => {
    // The cursor is 45 minutes old and the run started 3 hours ago: only a lookback of hours
    // reaches its start time.
    const cursor = new Date(Date.now() - 45 * 60_000).toISOString();
    await db.query("insert into watchdog_state (id, cursor) values (1, $1)", [
      cursor,
    ]);
    const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/v1/workflows/definitions") return DEFS;
      if (url.pathname === "/v1/workflows/executions") {
        const from = Date.parse(url.searchParams.get("from")!);
        return url.searchParams.get("definitionId") === "def-copilot" &&
          Date.parse(startedAt) >= from
          ? [exec("11", { startedAt })]
          : [];
      }
      return {};
    });
    const r = run(fetch);
    expect((await r.done).posted).toEqual(["11"]);
  });

  it("skips a tick while another holds the lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const held = db.tryLock("sylon.watchdog.tick", () => gate);
    const other = await db.tryLock("sylon.watchdog.tick", async () => 1);
    expect(other).toEqual({ held: false });
    release();
    await held;
    expect(await db.tryLock("sylon.watchdog.tick", async () => 1)).toEqual({
      held: true,
      value: 1,
    });
  });

  it("neutralises a broadcast mention in the notification text", async () => {
    const { fetch } = stubFetch((url) => {
      if (url.pathname === "/v1/workflows/definitions") return DEFS;
      if (url.pathname === "/v1/workflows/executions")
        return url.searchParams.get("definitionId") === "def-copilot"
          ? [exec("11")]
          : [];
      return {
        ...exec("11"),
        error: "bad <!channel> & <!here|x>",
        steps: [],
      };
    });
    const r = run(fetch);
    await r.done;
    const text = posts(r.logs)[0].text;
    expect(text).not.toContain("<!");
    expect(text).not.toContain("<");
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

describe("describeFailure", () => {
  it("names the failed step by stepName and reports its own error, not the retry-cap summary", () => {
    const row = {
      id: "848858",
      definitionId: "905",
      status: "failed",
      currentStep: "receive",
      currentStepAttempt: 2,
      startedAt: "2026-10-03T00:23:50Z",
      finishedAt: "2026-10-03T00:29:48Z",
    };
    const f = describeFailure(
      "sylon-copilot",
      row as never,
      {
        ...row,
        error: {
          message:
            "Step 'receive' exceeded retry cap (attempted 3 of 3); fault: workload",
        },
        steps: [
          {
            stepName: "receive",
            attempt: 2,
            status: "failed",
            faultClass: "workload",
            error: {
              message:
                "POST https://llm.services.sapiom.ai/v2/anthropic/v1/messages → 400 model_not_available",
            },
          },
        ],
      } as never,
      33,
    );
    expect(f.step).toBe("receive");
    expect(f.error).toContain("model_not_available");
    expect(actionItems(f.slug, f.step, f.error)[0]).toMatch(/routing label/);
  });
});
