/**
 * The Sylon Console server: one page and a few JSON routes from which the demo is operated.
 *
 * Every piece of state lives in the `sylon` database or the Sapiom API; the server keeps none, so
 * a fresh App Link wake shows exactly what a running one would. `pnpm run console:build` bundles
 * this file, the page and the `_shared` code into one `dist/server.mjs` that needs no install.
 *
 * Env: SAPIOM_API_KEY (an org key: it lists and changes triggers, starts runs, replays receipts,
 * and resolves the database), CONSOLE_SECRET (required by every POST; see `checkSecret`),
 * PORT (default 3000), SAPIOM_API_URL (default production).
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createClient } from "@sapiom/tools";

import { getConfig } from "../../_shared/config";
import {
  connectPostgres,
  resolveConnectionString,
  type Db,
} from "../../_shared/db";
import { resetBoard } from "../../_shared/reset";
import { permalink } from "../../_shared/slack";
import cues from "./cues.json";
import page from "./index.html";
import {
  AGENTS,
  CONTROLLER,
  LIVE_AGENT,
  SECRET_HEADER,
  agentByKey,
  checkSecret,
  failedFleetReceipts,
  fleetWideKeys,
  isOn,
  latencies,
  planSwitch,
  triggerBody,
  triggerStates,
  type AttachedTrigger,
  type ReceiptSummary,
} from "./logic";

const PORT = Number(process.env.PORT) || 3000;
const API = (process.env.SAPIOM_API_URL ?? "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY ?? "";
const SECRET = process.env.CONSOLE_SECRET;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Sapiom API ------------------------------------------------------------------------------

async function sapiom<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!API_KEY) throw new HttpError(503, "SAPIOM_API_KEY is not set");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // not JSON; keep the raw text
    }
    throw new HttpError(res.status, `${method} ${path}: ${message}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The agent's attached triggers, or null when its definition is not deployed. */
async function attachedTriggers(
  slug: string,
): Promise<AttachedTrigger[] | null> {
  try {
    return await sapiom<AttachedTrigger[]>(
      "GET",
      `/v1/workflows/definitions/${slug}/triggers`,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

async function fleetState() {
  return Promise.all(
    AGENTS.map(async (a) => {
      const attached = await attachedTriggers(a.slug);
      return {
        key: a.key,
        slug: a.slug,
        optional: Boolean(a.optional),
        deployed: attached !== null,
        on: attached ? isOn(a.key, attached) : false,
        triggers: attached ? triggerStates(a.key, attached) : [],
      };
    }),
  );
}

/** Turn one agent on or off; returns the trigger ids it created, resumed and deleted. */
async function setAgent(key: string, on: boolean) {
  const agent = agentByKey(key);
  if (!agent) throw new HttpError(404, `no agent '${key}' in fleet.json`);
  const attached = await attachedTriggers(agent.slug);
  if (!attached)
    throw new HttpError(
      409,
      `${agent.slug} is not deployed: run \`pnpm run setup --only ${key}\``,
    );
  const plan = planSwitch(key, on, attached);
  const created: string[] = [];
  for (const t of plan.create) {
    const out = await sapiom<{ id: string }>(
      "POST",
      `/v1/workflows/definitions/${agent.slug}/triggers`,
      triggerBody(t),
    );
    created.push(String(out.id));
  }
  for (const id of plan.resume)
    await sapiom("POST", `/v1/workflows/triggers/${id}/resume`);
  for (const id of plan.remove)
    await sapiom("DELETE", `/v1/workflows/triggers/${id}`);
  return { key, on, created, resumed: plan.resume, deleted: plan.remove };
}

// --- database --------------------------------------------------------------------------------

let dbPromise: Promise<Db> | undefined;

/** One connection pool for the server's life; dropped on an error so the next request reconnects. */
function db(): Promise<Db> {
  dbPromise ??= (async () => {
    const client = createClient({ apiKey: API_KEY });
    const { db } = await connectPostgres(
      await resolveConnectionString({ sapiom: client } as never),
    );
    return db;
  })();
  return dbPromise;
}

async function withConsoleDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  try {
    return await fn(await db());
  } catch (err) {
    if (!(err instanceof HttpError)) dbPromise = undefined;
    throw err;
  }
}

const triageLink = (triage: string, ts: string | null) =>
  ts ? permalink(triage, ts) : null;

async function board(d: Db) {
  const triage = await getConfig(d, "channels.triage");
  const counts = await d.query<{ status: string; n: string }>(
    "select status, count(*) as n from issues group by status",
  );
  const recent = await d.query<Record<string, unknown>>(
    `select i.id, i.number, a.name as account, i.title, i.status, i.priority, i.owner_slack_id,
            i.linear_identifier, i.triage_root_ts, i.created_at
       from issues i join accounts a on a.id = i.account_id
      order by i.number desc limit 20`,
  );
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    issues: recent.map((r) => ({
      id: r.id,
      number: Number(r.number),
      account: r.account,
      title: r.title,
      status: r.status,
      priority: r.priority,
      owner: r.owner_slack_id,
      linear: r.linear_identifier,
      createdAt: r.created_at,
      cardUrl: triageLink(triage, r.triage_root_ts as string | null),
    })),
  };
}

/** The newest issue (or issue `number`), with its latency legs, runs and event receipts. */
async function timeline(d: Db, number?: number) {
  const triage = await getConfig(d, "channels.triage");
  const issues = await d.query<Record<string, unknown>>(
    number === undefined
      ? "select * from issues order by number desc limit 1"
      : "select * from issues where number = $1",
    number === undefined ? [] : [number],
  );
  const issue = issues[0];
  if (!issue) return { issue: null };
  const id = issue.id as string;
  const [firstMessage] = await d.query<Record<string, unknown>>(
    "select ts, channel, created_at from messages where issue_id = $1 and direction = 'customer' order by created_at asc limit 1",
    [id],
  );
  const drafts = await d.query<Record<string, unknown>>(
    "select id, status, card_ts, created_at, confidence from drafts where issue_id = $1 order by created_at asc",
    [id],
  );
  const runs = await d.query<Record<string, unknown>>(
    "select execution_id, agent, started_at from runs where issue_id = $1 order by started_at asc",
    [id],
  );
  const events = await d.query<Record<string, unknown>>(
    "select type, emitted_by, receipt_id, created_at from events_log where payload->>'issueId' = $1 order by created_at asc",
    [id],
  );
  const firstDraft = drafts[0];
  return {
    issue: {
      id,
      number: Number(issue.number),
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      createdAt: issue.created_at,
      customerTs: firstMessage?.ts ?? null,
      triageRootTs: issue.triage_root_ts,
      cardUrl: triageLink(triage, issue.triage_root_ts as string | null),
    },
    latency: latencies({
      customerTs: (firstMessage?.ts as string | undefined) ?? null,
      triageRootTs: (issue.triage_root_ts as string | null) ?? null,
      issueCreatedAt: issue.created_at as Date,
      draftCreatedAt: (firstDraft?.created_at as Date | undefined) ?? null,
      draftCardTs: (firstDraft?.card_ts as string | undefined) ?? null,
    }),
    drafts: drafts.map((r) => ({
      id: r.id,
      status: r.status,
      cardTs: r.card_ts,
      createdAt: r.created_at,
      confidence: r.confidence == null ? null : Number(r.confidence),
      cardUrl:
        r.card_ts && issue.triage_root_ts
          ? permalink(
              triage,
              r.card_ts as string,
              issue.triage_root_ts as string,
            )
          : null,
    })),
    runs: runs.map((r) => ({
      executionId: r.execution_id,
      agent: r.agent,
      startedAt: r.started_at,
    })),
    events: events.map((r) => ({
      type: r.type,
      emittedBy: r.emitted_by,
      receiptId: r.receipt_id,
      createdAt: r.created_at,
    })),
  };
}

async function failedReceipts() {
  const receipts = await sapiom<ReceiptSummary[]>(
    "GET",
    "/v1/workflows/receipts?attention=true&limit=100",
  );
  return failedFleetReceipts(receipts);
}

// --- HTTP ------------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

type Handler = (
  params: string[],
  body: Record<string, unknown>,
  url: URL,
) => Promise<unknown>;

const GET: [RegExp, Handler][] = [
  [/^\/api\/fleet$/, () => fleetState()],
  [/^\/api\/board$/, () => withConsoleDb(board)],
  [
    /^\/api\/timeline$/,
    (_, __, url) => {
      const n = url.searchParams.get("issue");
      return withConsoleDb((d) => timeline(d, n ? Number(n) : undefined));
    },
  ],
  [/^\/api\/receipts\/failed$/, () => failedReceipts()],
  [/^\/api\/cues$/, async () => cues],
];

/** Every POST changes state and passes the secret check first. */
const POST: [RegExp, Handler][] = [
  [/^\/api\/auth$/, async () => ({ ok: true })],
  [/^\/api\/agents\/([a-z-]+)\/on$/, ([key]) => setAgent(key!, true)],
  [/^\/api\/agents\/([a-z-]+)\/off$/, ([key]) => setAgent(key!, false)],
  [
    /^\/api\/fleet\/(pause|resume)$/,
    async ([verb]) => {
      const states = await fleetState();
      const out = [];
      // Sequential, so a half-finished pause is easy to read and to finish by pressing again.
      for (const key of fleetWideKeys()) {
        if (!states.find((s) => s.key === key)?.deployed) continue;
        out.push(await setAgent(key, verb === "resume"));
      }
      return { verb, untouched: LIVE_AGENT, agents: out };
    },
  ],
  [
    /^\/api\/controller\/run$/,
    async () => {
      const slug = agentByKey(CONTROLLER)!.slug;
      return sapiom("POST", `/v1/workflows/definitions/${slug}/executions`, {
        input: {},
      });
    },
  ],
  [
    /^\/api\/board\/reset$/,
    async (_, body) => {
      // The page's confirm step sends this; a stray POST closes nothing.
      if (body.confirm !== "reset")
        throw new HttpError(400, 'send { "confirm": "reset" }');
      const ctx = { isLocalTrace: false, logger: console } as never;
      return { closed: await withConsoleDb((d) => resetBoard(d, ctx)) };
    },
  ],
  [
    /^\/api\/receipts\/(\d+)\/replay$/,
    ([id]) => sapiom("POST", `/v1/workflows/receipts/${id}/replay`),
  ],
];

function route(table: [RegExp, Handler][], path: string) {
  for (const [re, handler] of table) {
    const m = re.exec(path);
    if (m) return { handler, params: m.slice(1) };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://console");
  const path = url.pathname;
  if (req.method === "GET" && path === "/health")
    return send(res, 200, { ok: true });
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return void res.end(page);
  }
  const table =
    req.method === "GET" ? GET : req.method === "POST" ? POST : null;
  const hit = table && route(table, path);
  if (!hit) return send(res, 404, { error: "not found" });
  if (req.method === "POST") {
    const verdict = checkSecret(SECRET, req.headers[SECRET_HEADER]);
    if (verdict === "unset")
      return send(res, 503, {
        error: "CONSOLE_SECRET is not set; mutations are off",
      });
    if (verdict === "denied")
      return send(res, 401, { error: "wrong console secret" });
  }
  const body = req.method === "POST" ? await readJson(req) : {};
  return send(res, 200, await hit.handler(hit.params, body, url));
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error(`${req.method} ${req.url}: ${message}`);
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  });
}).listen(PORT, () => console.log(`sylon console on :${PORT}`));
