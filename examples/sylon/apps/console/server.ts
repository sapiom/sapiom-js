/**
 * The Sylon Console server: one page and a few JSON routes from which the demo is operated.
 *
 * Every piece of state lives in the `sylon` database or the Sapiom API; the server keeps none, so
 * a fresh App Link wake shows exactly what a running one would. `pnpm run console:build` bundles
 * this file, the page and the `_shared` code into one `dist/server.mjs` that needs no install.
 *
 * Env: SAPIOM_API_KEY (an org key: it lists and changes triggers, starts runs, replays receipts,
 * and resolves the database), PORT (default 3000), SAPIOM_API_URL (default production).
 *
 * There is no login of its own: the App Link admits only signed-in org members, and its preview
 * URL needs a one-hour token. Because the key is org-wide, every mutating route is scoped to the
 * fleet: fleet.json's triggers on fleet slugs, the controller's runs, and fires on fleet slugs.
 * The Knowledge tab's writes (`/api/kb`) touch only `kb_articles` and record `console` as editor.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { connectors, createClient } from "@sapiom/tools";

import { getConfig } from "../../_shared/config";
import {
  connectPostgres,
  resolveConnectionString,
  type Db,
} from "../../_shared/db";
import {
  UUID,
  createArticle,
  deleteArticle,
  listArticles,
  updateArticle,
} from "../../_shared/kb";
import { callTool } from "../../_shared/linear";
import { resetBoard } from "../../_shared/reset";
import { permalink } from "../../_shared/slack";
import replay from "../../scripts/replay.json";
import page from "./index.html";
import {
  AGENTS,
  AGENT_ROLES,
  CONTROLLER,
  LIVE_AGENT,
  TABLES,
  agentByKey,
  METRIC_WINDOWS,
  agentPageUrl,
  costOf,
  costSummary,
  cuesFromReplay,
  dispatchDelays,
  failedFleetReceipts,
  fleetWideKeys,
  isFinalSpend,
  isOn,
  latencies,
  linearIssueUrl,
  listensTo,
  parseKbInput,
  parseWindow,
  planSwitch,
  receiptView,
  replayPlan,
  redact,
  slackChannelUrl,
  spread,
  summarizeLatencies,
  toMs,
  triggerBody,
  triggerStates,
  type AttachedTrigger,
  type Cost,
  type ExecutionSpend,
  type IssueCost,
  type Latencies,
  type TimedFire,
  type ReceiptFire,
  type ReceiptSummary,
} from "./logic";

const PORT = Number(process.env.PORT) || 3000;
const API = (process.env.SAPIOM_API_URL ?? "https://api.sapiom.ai").replace(
  /\/+$/,
  "",
);
const API_KEY = process.env.SAPIOM_API_KEY ?? "";

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

/** Definition ids by slug, for the agent pages and for starting a run. */
async function definitionIds(): Promise<Map<string, string>> {
  const defs = await sapiom<{ id: string; slug: string }[]>(
    "GET",
    "/v1/workflows/definitions?limit=200",
  );
  return new Map(defs.map((x) => [x.slug, String(x.id)]));
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
  if (!agent) throw new HttpError(403, `'${key}' is not a Sylon agent`);
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

let projectPromise: Promise<{ name: string; url: string | null }> | undefined;

/** The Linear project's name and URL. Static for the server's life; a failed lookup is retried. */
function linearProject(d: Db) {
  projectPromise ??= getConfig(d, "linear.project_id")
    .then((query) => callTool("get_project", { query }))
    .then((p) => ({
      name: typeof p.name === "string" ? p.name : "Linear project",
      url: typeof p.url === "string" ? p.url : null,
    }))
    .catch(() => {
      projectPromise = undefined;
      return { name: "Linear project", url: null };
    });
  return projectPromise;
}

async function board(d: Db) {
  const triage = await getConfig(d, "channels.triage");
  const project = await linearProject(d);
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
      number: Number(r.number),
      account: r.account,
      title: r.title,
      status: r.status,
      priority: r.priority,
      owner: r.owner_slack_id,
      linear: r.linear_identifier,
      linearUrl: linearIssueUrl(
        project.url,
        r.linear_identifier as string | null,
      ),
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
  return failedFleetReceipts(receipts).map(receiptView);
}

// --- metrics ---------------------------------------------------------------------------------

/** Issues priced and timed per request, newest first; bounds the API calls a page load can cost. */
const METRIC_ISSUES = 50;
/** Spend reads not already cached, per request; the rest are counted as missing and fill in on later loads. */
const SPEND_CALLS = 150;
const DETAIL_CALLS = 50;
const CONCURRENCY = 8;

/** Final spend by execution id: an execution that has settled never changes. */
const spendCache = new Map<string, Cost>();
/** Dispatch delays by receipt id, kept once every fleet fire of the receipt has a start time. */
const dispatchCache = new Map<string, number[]>();

/** `fn` over `items`, `CONCURRENCY` at a time; a failed item yields null rather than failing the page. */
async function pooled<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!).catch(() => null);
      }
    }),
  );
  return out;
}

async function executionCosts(ids: string[]): Promise<Map<string, Cost>> {
  const out = new Map<string, Cost>();
  const todo: string[] = [];
  for (const id of ids) {
    const hit = spendCache.get(id);
    if (hit) out.set(id, hit);
    else todo.push(id);
  }
  const batch = todo.slice(0, SPEND_CALLS);
  const spends = await pooled(batch, (id) =>
    sapiom<ExecutionSpend>("GET", `/v1/workflows/executions/${id}/spend`),
  );
  batch.forEach((id, n) => {
    const spend = spends[n];
    if (!spend) return;
    const cost = costOf(spend);
    // A run still settling is shown now and read again next time.
    if (isFinalSpend(spend)) spendCache.set(id, cost);
    out.set(id, cost);
  });
  return out;
}

/** Receipt arrival → run start for each Sylon fire of the receipts received since `since`. */
async function dispatchSeconds(since: number): Promise<number[]> {
  const slugs = new Set(AGENTS.map((a) => a.slug));
  const list = await sapiom<ReceiptSummary[]>(
    "GET",
    "/v1/workflows/receipts?limit=100",
  );
  const mine = list.filter(
    (r) =>
      (toMs(r.receivedAt) ?? 0) >= since &&
      r.triggerSlugs.some((slug) => slugs.has(slug)),
  );
  const seen = new Map<string, number[]>();
  const fresh = mine
    .filter((r) => !dispatchCache.has(r.id))
    .slice(0, DETAIL_CALLS);
  const details = await pooled(fresh, (r) =>
    sapiom<{ fires?: TimedFire[] }>("GET", `/v1/workflows/receipts/${r.id}`),
  );
  fresh.forEach((r, n) => {
    const fires = details[n]?.fires;
    if (!fires) return;
    const delays = dispatchDelays(r.receivedAt, fires);
    const ours = fires.filter(
      (f) => f.trigger && slugs.has(f.trigger.definitionSlug),
    );
    seen.set(r.id, delays);
    // Cached only once every fleet fire has started; an earlier read would freeze a partial list.
    if (ours.length > 0 && delays.length === ours.length)
      dispatchCache.set(r.id, delays);
  });
  return mine.flatMap((r) => dispatchCache.get(r.id) ?? seen.get(r.id) ?? []);
}

async function metrics(d: Db, window: keyof typeof METRIC_WINDOWS) {
  const since = Date.now() - METRIC_WINDOWS[window];
  const issues = await d.query<Record<string, unknown>>(
    `select id, number, created_at, triage_root_ts from issues
      where created_at >= $1 order by number desc limit ${METRIC_ISSUES}`,
    [new Date(since).toISOString()],
  );
  const ids = issues.map((i) => i.id as string);
  const [firstMessages, firstDrafts, runs] = ids.length
    ? await Promise.all([
        d.query<Record<string, unknown>>(
          `select distinct on (issue_id) issue_id, ts from messages
            where issue_id = any($1) and direction = 'customer' order by issue_id, created_at asc`,
          [ids],
        ),
        d.query<Record<string, unknown>>(
          `select distinct on (issue_id) issue_id, card_ts, created_at from drafts
            where issue_id = any($1) order by issue_id, created_at asc`,
          [ids],
        ),
        d.query<Record<string, unknown>>(
          "select execution_id, issue_id from runs where issue_id = any($1)",
          [ids],
        ),
      ])
    : [[], [], []];
  const messageOf = new Map(firstMessages.map((m) => [m.issue_id, m]));
  const draftOf = new Map(firstDrafts.map((m) => [m.issue_id, m]));
  const executions = [...new Set(runs.map((r) => r.execution_id as string))];

  const [costs, dispatch] = await Promise.all([
    executionCosts(executions),
    dispatchSeconds(since).catch(() => [] as number[]),
  ]);

  const rows = issues.map((i) => {
    const mine = runs
      .filter((r) => r.issue_id === i.id)
      .map((r) => r.execution_id as string);
    const counted = mine.filter((id) => costs.has(id));
    const total = counted.reduce<Cost>(
      (t, id) => {
        const c = costs.get(id)!;
        return {
          usd: t.usd + c.usd,
          llmUsd: t.llmUsd + c.llmUsd,
          capabilityUsd: t.capabilityUsd + c.capabilityUsd,
          sandboxSeconds: t.sandboxSeconds + c.sandboxSeconds,
        };
      },
      { usd: 0, llmUsd: 0, capabilityUsd: 0, sandboxSeconds: 0 },
    );
    const draft = draftOf.get(i.id);
    const latency: Latencies = latencies({
      customerTs: (messageOf.get(i.id)?.ts as string | undefined) ?? null,
      triageRootTs: (i.triage_root_ts as string | null) ?? null,
      issueCreatedAt: i.created_at as Date,
      draftCreatedAt: (draft?.created_at as Date | undefined) ?? null,
      draftCardTs: (draft?.card_ts as string | undefined) ?? null,
    });
    const cost: IssueCost = {
      ...total,
      runsCounted: counted.length,
      runsMissing: mine.length - counted.length,
    };
    return { number: Number(i.number), latency, cost };
  });

  return {
    window,
    issues: rows.length,
    capped: rows.length === METRIC_ISSUES,
    latency: summarizeLatencies(rows.map((r) => r.latency)),
    dispatch: spread(dispatch),
    cost: costSummary(rows.map((r) => r.cost)),
    runsMissing: rows.reduce((n, r) => n + r.cost.runsMissing, 0),
    perIssue: rows.map((r) => ({
      number: r.number,
      ...r.latency,
      usd: r.cost.runsCounted ? r.cost.usd : null,
      llmUsd: r.cost.llmUsd,
      capabilityUsd: r.cost.capabilityUsd,
      sandboxSeconds: r.cost.sandboxSeconds,
      runsMissing: r.cost.runsMissing,
    })),
  };
}

/**
 * The system map: channels, agents, tables and the Linear project, as ids, names and links only.
 * Slack names no team id in config, so it is read off the on-call user's profile; a lookup that
 * fails leaves its link out rather than failing the page.
 */
async function system(d: Db) {
  const [triage, customers, oncall] = await Promise.all([
    getConfig(d, "channels.triage"),
    getConfig(d, "channels.customer"),
    getConfig(d, "oncall.slack_id"),
  ]);
  const [teamId, project, definitions] = await Promise.all([
    connectors.slack
      .userInfo({ user: oncall })
      .then(
        (r) => (r.user as { team_id?: string } | undefined)?.team_id ?? null,
      )
      .catch(() => null),
    linearProject(d),
    definitionIds().catch(() => new Map<string, string>()),
  ]);
  const channel = (channelId: string) => ({
    channelId,
    url: teamId ? slackChannelUrl(teamId, channelId) : null,
  });
  const ids = definitions;
  return {
    slack: {
      teamId,
      triage: channel(triage),
      customers: customers.map((c) => ({
        ...channel(c.channelId),
        accountName: c.accountName,
      })),
    },
    linear: project,
    agents: AGENTS.map((a) => {
      const definitionId = ids.get(a.slug) ?? null;
      return {
        key: a.key,
        slug: a.slug,
        definitionId,
        url: definitionId ? agentPageUrl(definitionId) : null,
        listens: listensTo(a.key),
        emits: AGENT_ROLES[a.key]?.emits ?? [],
        writes: AGENT_ROLES[a.key]?.writes ?? "",
      };
    }),
    tables: TABLES.map(([name, role]) => ({ name, role })),
  };
}

/** Re-drive a receipt's failed fleet fires, one by one; see `replayPlan`. */
async function replayReceipt(id: string) {
  const receipt = await sapiom<{ fires?: ReceiptFire[] }>(
    "GET",
    `/v1/workflows/receipts/${id}`,
  );
  const plan = replayPlan(receipt.fires ?? []);
  if (!plan.ok) throw new HttpError(plan.status, plan.reason);
  const replayed = [];
  for (const fireId of plan.fireIds)
    replayed.push(
      await sapiom("POST", `/v1/workflows/fires/${fireId}/replay`, {}),
    );
  return { receiptId: id, fireIds: plan.fireIds, replayed };
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
  [
    /^\/api\/metrics$/,
    (_, __, url) => {
      const window = parseWindow(url.searchParams.get("window"));
      if (!window) throw new HttpError(400, "window must be 24h or 7d");
      return withConsoleDb((d) => metrics(d, window));
    },
  ],
  [/^\/api\/cues$/, async () => cuesFromReplay(replay)],
  [/^\/api\/system$/, () => withConsoleDb(system)],
  [/^\/api\/kb$/, () => withConsoleDb(listArticles)],
];

/** Every POST changes state, and each is scoped to the fleet. */
const POST: [RegExp, Handler][] = [
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
      const definitionId = (await definitionIds()).get(slug);
      if (!definitionId) throw new HttpError(409, `${slug} is not deployed`);
      // The public API starts a run by definition id; the by-slug route is engine-internal.
      return sapiom("POST", "/v1/workflows/executions", {
        definitionId,
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
  [/^\/api\/receipts\/(\d+)\/replay$/, ([id]) => replayReceipt(id!)],
  [/^\/api\/kb$/, (_, body) => createKbArticle(body)],
];

/** Knowledge base writes touch only `kb_articles`, and record the Console as the editor. */
const KB_EDITOR = "console";

async function createKbArticle(body: Record<string, unknown>) {
  const parsed = parseKbInput(body, "create");
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  return withConsoleDb((d) =>
    createArticle(d, parsed.value as Required<typeof parsed.value>, KB_EDITOR),
  );
}

async function updateKbArticle(id: string, body: Record<string, unknown>) {
  if (!UUID.test(id)) throw new HttpError(404, "article not found");
  const parsed = parseKbInput(body, "update");
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const article = await withConsoleDb((d) =>
    updateArticle(d, id, parsed.value, KB_EDITOR),
  );
  if (!article) throw new HttpError(404, "article not found");
  return article;
}

async function deleteKbArticle(id: string) {
  if (!UUID.test(id)) throw new HttpError(404, "article not found");
  if (!(await withConsoleDb((d) => deleteArticle(d, id))))
    throw new HttpError(404, "article not found");
  return { deleted: id };
}

const PUT: [RegExp, Handler][] = [
  [/^\/api\/kb\/([^/]+)$/, ([id], body) => updateKbArticle(id!, body)],
];

const DELETE: [RegExp, Handler][] = [
  [/^\/api\/kb\/([^/]+)$/, ([id]) => deleteKbArticle(id!)],
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
    req.method === "GET"
      ? GET
      : req.method === "POST"
        ? POST
        : req.method === "PUT"
          ? PUT
          : req.method === "DELETE"
            ? DELETE
            : null;
  const hit = table && route(table, path);
  if (!hit) return send(res, 404, { error: "not found" });
  const body =
    req.method === "POST" || req.method === "PUT" ? await readJson(req) : {};
  return send(res, 200, await hit.handler(hit.params, body, url));
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    const raw = redact(err instanceof Error ? err.message : String(err), [
      API_KEY,
    ]);
    if (status >= 500) console.error(`${req.method} ${req.url}: ${raw}`);
    // Only our own HttpError messages reach the page; a driver or network error could name a
    // host or carry a connection detail, so it stays in the server log.
    const message = err instanceof HttpError ? raw : "internal error";
    if (!res.headersSent) send(res, status, { error: message });
    else res.end();
  });
}).listen(PORT, () => console.log(`sylon console on :${PORT}`));
