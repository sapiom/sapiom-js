/** Capture the handler and use pg-mem so route tests require neither a listening socket nor PostgreSQL. */
import { Readable } from "node:stream";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { getConfigOr, setConfig } from "../../_shared/config";
import { memoryDb, type Db } from "../../_shared/db";
import { upsertDesk } from "../../_shared/desks";
import { agentSlug } from "../../_shared/fleet-id";
import { ensureAccount, openIssue } from "../../_shared/issues";
import { EXAMPLE_SLA } from "../../_shared/test-ctx";

type Handler = (req: unknown, res: unknown) => void;
const captured = vi.hoisted(() => ({
  handler: undefined as Handler | undefined,
  db: undefined as unknown,
}));

vi.mock("node:http", () => ({
  createServer: (handler: Handler) => {
    captured.handler = handler;
    return { listen: () => undefined };
  },
}));
vi.mock("./index.html", () => ({ default: "<html></html>" }));
vi.mock("@sapiom/tools", () => ({ createClient: () => ({}) }));
vi.mock("../../_shared/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../_shared/db")>()),
  resolveConnectionString: async () => "postgres://memory",
  connectPostgres: async () => ({ db: captured.db }),
}));

function call(method: string, url: string, body?: unknown) {
  const req = Object.assign(
    Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ),
    { method, url },
  );
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve) => {
      let status = 0;
      const res = {
        headersSent: false,
        writeHead: (s: number) => void (status = s),
        end: (text: string) => resolve({ status, body: JSON.parse(text) }),
      };
      captured.handler!(req, res);
    },
  );
}

let db: Db;
/** The Sapiom API calls the server made; answered offline below. */
const apiCalls: { method: string; url: string; body: unknown }[] = [];

beforeAll(async () => {
  // Offline: the server's Sapiom API calls get canned answers, and the key is a placeholder.
  vi.stubEnv("SAPIOM_API_KEY", "test-key");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    apiCalls.push({
      method,
      url,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.endsWith("/v1/workflows/definitions?limit=200"))
      return json([{ id: "def-ctl", slug: agentSlug("controller") }]);
    if (
      url.endsWith(
        `/v1/workflows/definitions/${agentSlug("controller")}/triggers`,
      )
    )
      return json([]);
    if (url.endsWith("/v1/workflows/executions") && method === "POST")
      // The engine's answer: the run id is `executionId`, not `id`.
      return json({ status: "running", executionId: "exec-rearm" });
    return new Response("not found", { status: 404 });
  });
  db = await memoryDb();
  captured.db = db;
  const desk = (
    await upsertDesk(db, {
      slug: "support",
      name: "Support",
      triageChannel: "C0SUPTRI",
      isDefault: true,
    })
  ).desk;
  const account = await ensureAccount(db, {
    name: "Acme",
    slackChannelId: "C0ACME",
    deskId: desk.id,
  });
  await openIssue(db, {
    accountId: account.id,
    source: "slack",
    category: "bug",
    priority: "urgent",
    title: "Down",
    customer: { channel: "C0ACME", ts: "1790000000.000100" },
  });
  await import("./server");
});

describe("console server SLA routes", () => {
  it("maps GET, PUT and DELETE /api/sla to the sla key, and a bad body to 400", async () => {
    expect(await call("GET", "/api/sla")).toEqual({
      status: 200,
      body: { sla: null },
    });

    const bad = await call("PUT", "/api/sla", {
      ...EXAMPLE_SLA,
      businessHours: { ...EXAMPLE_SLA.businessHours, timeZone: "Nowhere/City" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/timeZone/);
    expect(await getConfigOr({ ...db }, "sla", null)).toBeNull();

    apiCalls.length = 0;
    // A saved target moves when tickets come due, so every open ticket's timer is reset.
    expect(await call("PUT", "/api/sla", EXAMPLE_SLA)).toEqual({
      status: 200,
      body: { sla: EXAMPLE_SLA, timers: { reset: true, run: "exec-rearm" } },
    });
    expect(apiCalls.filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        url: expect.stringMatching(/\/v1\/workflows\/executions$/),
        body: { definitionId: "def-ctl", input: {} },
      },
    ]);
    expect(await call("GET", "/api/sla")).toEqual({
      status: 200,
      body: { sla: EXAMPLE_SLA },
    });
    const [row] = await db.query<{ set_by: string }>(
      "select set_by from config where key = 'sla'",
    );
    expect(row.set_by).toBe("console");

    expect(await call("DELETE", "/api/sla")).toEqual({
      status: 200,
      body: { sla: null, timers: { reset: true, run: "exec-rearm" } },
    });
    expect(await getConfigOr({ ...db }, "sla", null)).toBeNull();
  });

  it("adds each issue's SLA clock to /api/board rows, and nulls without an sla", async () => {
    const without = await call("GET", "/api/board");
    expect(without.status).toBe(200);
    expect(without.body.issues).toEqual([
      expect.objectContaining({
        slaKind: null,
        slaDueAt: null,
        slaLabel: null,
      }),
    ]);

    await setConfig(db, "sla", EXAMPLE_SLA, "test");
    const query = vi.spyOn(db, "query");
    const withSla = await call("GET", "/api/board");
    // The clocks of every board row come from one read of their messages.
    const reads = query.mock.calls.filter(([sql]) => /from messages/.test(sql));
    expect(reads).toHaveLength(1);
    expect(reads[0][0]).toMatch(/issue_id = any\(\$1\)/);
    query.mockRestore();
    const [issue] = withSla.body.issues as Record<string, unknown>[];
    expect(issue.slaKind).toBe("first_response");
    expect(issue.slaLabel).toMatch(/^first response in 1[45]m$/);
    expect(typeof issue.slaDueAt).toBe("string");
  });
});

describe("console server controller switch", () => {
  it("names the started run in the switch's and Reset ticket timers' responses", async () => {
    const off = await call("POST", "/api/agents/controller/off");
    expect(off).toMatchObject({
      status: 200,
      body: { key: "controller", on: false, run: "exec-rearm" },
    });
    expect(await getConfigOr({ ...db }, "controller.paused", null)).toBe(true);
    const on = await call("POST", "/api/agents/controller/on");
    expect(on.body).toMatchObject({ on: true, run: "exec-rearm" });
    expect(await getConfigOr({ ...db }, "controller.paused", null)).toBe(false);
    expect(await call("POST", "/api/controller/run")).toEqual({
      status: 200,
      body: { executionId: "exec-rearm", status: "running" },
    });
  });
});
