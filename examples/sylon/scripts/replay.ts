/**
 * `pnpm run replay`: post the demo conversation (`scripts/replay.json`) in the customer channel as
 * a test customer, and print each receipt, run, issue, draft card and nudge as it appears.
 *
 * Customer messages must come from a real Slack user, because the Slack connector drops bot posts.
 * With `SLACK_REPLAY_USER_TOKEN` (a user token, `xoxp-...`, of a test customer account with
 * `chat:write`) the script posts each step itself, straight to the Slack Web API. Without it, it
 * prints the steps for a person to post and only watches. `--watch-only` forces that mode.
 *
 * Flags: `--watch-only`, `--timeout <s>` (default 900), `--settle <s>`: stop after this long with
 * nothing new and no run in flight (default 150). Exits 1 if any Sylon run failed.
 *
 * Needs SAPIOM_API_KEY (an org key for the target org). Prints no secrets.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createClient as createGatewayClient,
  type GatewayClient,
} from "@sapiom/agent-core";
import { createClient } from "@sapiom/tools";
import { z } from "zod/v4";

import { getConfig } from "../_shared/config";
import {
  connectPostgres,
  resolveConnectionString,
  type Db,
} from "../_shared/db";
import { permalink } from "../_shared/slack";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNS_PAGE = "https://app.sapiom.ai/agents/runs";
const EVENTS_PAGE = "https://app.sapiom.ai/agents/events";
const POLL_MS = 3000;

export const Replay = z.object({
  description: z.string(),
  /** Put in front of every message; empty for the live show. */
  prefix: z.string(),
  steps: z
    .array(
      z.object({
        id: z.string(),
        /** Post as a reply in this earlier step's thread. */
        threadOf: z.string().optional(),
        text: z.string(),
        expect: z.string(),
        pauseSeconds: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type Replay = z.infer<typeof Replay>;

export function loadReplay(file = path.join(DIR, "replay.json")): Replay {
  const replay = Replay.parse(JSON.parse(readFileSync(file, "utf8")));
  const seen = new Set<string>();
  for (const s of replay.steps) {
    if (s.threadOf && !seen.has(s.threadOf))
      throw new Error(
        `step '${s.id}' threads on '${s.threadOf}', which does not come before it`,
      );
    seen.add(s.id);
  }
  return replay;
}

export const messageText = (replay: Replay, text: string) =>
  replay.prefix ? `${replay.prefix} ${text}` : text;

/** Seconds between two Slack timestamps (`1790889355.981329`). */
export const tsGap = (from: string, to: string) =>
  Math.round((Number(to) - Number(from)) * 10) / 10;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`${clock()}  ${line}`);

// --- posting ----------------------------------------------------------------------------------

async function postAsUser(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
  const body = (await res.json()) as {
    ok: boolean;
    ts?: string;
    error?: string;
  };
  if (!body.ok || !body.ts)
    throw new Error(`chat.postMessage failed: ${body.error ?? res.status}`);
  return body.ts;
}

// --- watching ---------------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  eventType: string;
  outcome: string;
  triggerSlugs: string[];
}
interface Fire {
  state: string;
  error: unknown;
  executionId: string | null;
  trigger: { definitionSlug: string };
  execution: { status: string } | null;
}

/**
 * A fire is finished when it could not start a run (`failed`, `skipped`, `stale`) or its run left
 * the in-progress states. The fire's own `succeeded` only means the run was started.
 */
const UNFIRED = new Set(["failed", "skipped", "stale"]);
const IN_PROGRESS = new Set([
  "pending",
  "queued",
  "running",
  "paused",
  "waiting",
]);
const finished = (f: Fire) =>
  UNFIRED.has(f.state) ||
  (!!f.execution && !IN_PROGRESS.has(f.execution.status));
const isSylon = (slug: string) => slug.startsWith("sylon-");

class Watcher {
  private receipts = new Map<string, { type: string; done: boolean }>();
  private fires = new Set<string>();
  private seen = new Set<string>();
  readonly failed: string[] = [];
  readonly executions: string[] = [];
  lastActivity = Date.now();

  constructor(
    private client: GatewayClient,
    private db: Db,
    private since: Date,
    private baselineReceipt: number,
    private triage: string,
  ) {}

  get inFlight(): number {
    return [...this.receipts.values()].filter((r) => !r.done).length;
  }

  private fresh(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.lastActivity = Date.now();
    return true;
  }

  async poll(): Promise<void> {
    await Promise.all([this.pollReceipts(), this.pollDb()]);
  }

  private async pollReceipts() {
    const rows = await this.client.get<ReceiptRow[]>("/receipts?limit=50");
    for (const r of rows.reverse()) {
      if (Number(r.id) <= this.baselineReceipt) continue;
      if (!r.triggerSlugs.some(isSylon)) continue;
      if (!this.receipts.has(r.id)) {
        this.receipts.set(r.id, { type: r.eventType, done: false });
        this.lastActivity = Date.now();
        log(
          `receipt ${r.id} ${r.eventType} → ${r.triggerSlugs.filter(isSylon).join(", ")}  ${EVENTS_PAGE}/${r.id}`,
        );
      }
    }
    for (const [id, r] of this.receipts) {
      if (r.done) continue;
      const detail = await this.client.get<{ fires: Fire[] }>(
        `/receipts/${id}`,
      );
      const mine = detail.fires.filter((f) =>
        isSylon(f.trigger.definitionSlug),
      );
      for (const f of mine) {
        if (!finished(f)) continue;
        const key = `${id}:${f.executionId ?? f.trigger.definitionSlug}`;
        if (this.fires.has(key)) continue;
        this.fires.add(key);
        if (f.executionId) this.executions.push(f.executionId);
        this.lastActivity = Date.now();
        const status = f.execution?.status ?? f.state;
        if (status !== "completed")
          this.failed.push(
            `${f.trigger.definitionSlug} run ${f.executionId ?? "(none)"} (receipt ${id}): ${status}`,
          );
        log(
          `  run ${f.executionId ?? "(none)"} ${f.trigger.definitionSlug}: ${status}${f.executionId ? `  ${RUNS_PAGE}/${f.executionId}` : ""}`,
        );
      }
      r.done = mine.length > 0 && mine.every(finished);
    }
  }

  private async pollDb() {
    const since = this.since.toISOString();
    const issues = await this.db.query<{
      id: string;
      number: number;
      priority: string;
      category: string;
      title: string;
      customer_root_ts: string | null;
      triage_root_ts: string | null;
    }>(
      `select id, number, priority, category, title, customer_root_ts, triage_root_ts
         from issues where created_at >= $1 order by number`,
      [since],
    );
    for (const i of issues) {
      if (!i.triage_root_ts || !this.fresh(`issue:${i.id}`)) continue;
      const gap = i.customer_root_ts
        ? `, ${tsGap(i.customer_root_ts, i.triage_root_ts)}s after the post`
        : "";
      log(
        `issue #${i.number} [${i.priority} ${i.category}] ${i.title}: card${gap}  ${permalink(this.triage, i.triage_root_ts)}`,
      );
    }
    const drafts = await this.db.query<{
      id: string;
      number: number;
      status: string;
      card_ts: string | null;
      triage_root_ts: string | null;
      citations: unknown;
    }>(
      `select d.id, i.number, d.status, d.card_ts, i.triage_root_ts, d.citations
         from drafts d join issues i on i.id = d.issue_id
        where d.created_at >= $1 order by d.created_at`,
      [since],
    );
    for (const d of drafts) {
      if (d.card_ts && this.fresh(`draft:${d.id}`)) {
        const gap = d.triage_root_ts
          ? `, ${tsGap(d.triage_root_ts, d.card_ts)}s after the issue card`
          : "";
        log(
          `draft card for #${d.number} (cites ${JSON.stringify(d.citations)})${gap}`,
        );
      }
      if (d.status !== "pending" && this.fresh(`draft:${d.id}:${d.status}`))
        log(`draft for #${d.number}: ${d.status}`);
    }
    const replies = await this.db.query<{
      id: string;
      number: number | null;
      user_id: string;
      text: string;
    }>(
      `select m.id, i.number, m.user_id, m.text from messages m left join issues i on i.id = m.issue_id
        where m.created_at >= $1 and m.direction <> 'customer' order by m.created_at`,
      [since],
    );
    for (const m of replies)
      if (this.fresh(`message:${m.id}`))
        log(
          `${m.user_id} posted${m.number ? ` on #${m.number}` : ""}: ${m.text.replace(/\s+/g, " ").slice(0, 90)}`,
        );
    const nudges = await this.db.query<{ number: number; kind: string }>(
      `select i.number, n.kind from nudges n join issues i on i.id = n.issue_id
        where n.sent_at >= $1 order by n.sent_at`,
      [since],
    );
    for (const n of nudges)
      if (this.fresh(`nudge:${n.number}:${n.kind}`))
        log(`controller nudge on #${n.number}: ${n.kind}`);
  }
}

// --- main -------------------------------------------------------------------------------------

async function main() {
  const replay = loadReplay();
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  const token = process.argv.includes("--watch-only")
    ? undefined
    : process.env.SLACK_REPLAY_USER_TOKEN;
  const timeoutMs = arg("--timeout", 900) * 1000;
  const settleMs = arg("--settle", 150) * 1000;

  const sapiom = createClient({ apiKey });
  const client = createGatewayClient({ apiKey });
  const { db, close } = await connectPostgres(
    await resolveConnectionString({ sapiom } as never),
  );
  try {
    const [customer] = await getConfig(db, "channels.customer");
    const triage = await getConfig(db, "channels.triage");
    const [latest] = await client.get<ReceiptRow[]>("/receipts?limit=1");
    const since = new Date();
    const watcher = new Watcher(
      client,
      db,
      since,
      Number(latest?.id ?? 0),
      triage,
    );

    let posting = true;
    const steps = (async () => {
      if (!token) {
        console.log(
          `No SLACK_REPLAY_USER_TOKEN: post these as the test customer in ${customer.accountName} (${customer.channelId}), in order:\n`,
        );
        replay.steps.forEach((s, n) =>
          console.log(
            `${n + 1}. ${s.threadOf ? `(reply in the thread of step '${s.threadOf}') ` : ""}${messageText(replay, s.text)}\n   expect: ${s.expect}\n`,
          ),
        );
        console.log("Watching. Ctrl-C to stop.\n");
        posting = false;
        return;
      }
      const tsOf = new Map<string, string>();
      for (const s of replay.steps) {
        const ts = await postAsUser(
          token,
          customer.channelId,
          messageText(replay, s.text),
          s.threadOf ? tsOf.get(s.threadOf) : undefined,
        );
        tsOf.set(s.id, ts);
        log(
          `posted '${s.id}' ${permalink(customer.channelId, ts, s.threadOf ? tsOf.get(s.threadOf) : undefined)}`,
        );
        log(`  expect: ${s.expect}`);
        watcher.lastActivity = Date.now();
        await sleep(s.pauseSeconds * 1000);
      }
      posting = false;
    })();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await watcher
        .poll()
        .catch((err: unknown) =>
          log(`poll failed: ${err instanceof Error ? err.message : err}`),
        );
      if (
        !posting &&
        watcher.inFlight === 0 &&
        Date.now() - watcher.lastActivity > settleMs
      )
        break;
      await sleep(POLL_MS);
    }
    await steps;

    console.log(
      `\n${watcher.executions.length} Sylon run(s): ${watcher.executions.join(", ") || "none"}`,
    );
    if (watcher.failed.length) {
      console.log(`failed:\n- ${watcher.failed.join("\n- ")}`);
      process.exitCode = 1;
    } else console.log("no failed runs");
  } finally {
    await close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
