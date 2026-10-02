/**
 * watchdog: the failure alarm. Every tick it lists the failed runs of the Sylon agents (itself
 * and the smoke agents excluded) and posts one Slack message per new failure: which agent and
 * step, the error, a link, and what to do about it.
 *
 * Trigger: `schedule_cron` (`*\/5 * * * *` in fleet.json). No event fires when a run fails, so
 * this polls `GET /v1/workflows/executions?status=failed`.
 *
 * Credential: that route needs `org.read`, which the per-run key behind `ctx.sapiom` does not
 * hold. `pnpm run setup` mints a read-only key and stores it as this agent's secret
 * `SYLON_WATCHDOG_API_KEY`, which the engine injects as an environment variable. Channel:
 * `alerts.channel`, else `channels.triage`.
 *
 * State: `watchdog_reported` holds every execution already announced (the dedup) and
 * `watchdog_state` one cursor. A failure is posted, then recorded (post then record, a known
 * limitation), and the cursor moves only when the whole tick succeeded, so a failed post is
 * retried next tick.
 */
import {
  defineAgent,
  defineStep,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { z } from "zod/v4";

import { getConfig, getConfigOr } from "../../_shared/config";
import { withDb, type Db } from "../../_shared/db";
import { post, type SlackCtx } from "../../_shared/slack";

import {
  describeFailure,
  failureMessage,
  lookbackFrom,
  moreMessage,
  newFailures,
  splitBatch,
  WATCHED_SLUGS,
  type Execution,
  type ExecutionDetail,
} from "./logic";

export const AGENT = "sylon-watchdog";
export const KEY_ENV = "SYLON_WATCHDOG_API_KEY";

const API_URL = "https://api.sapiom.ai";
const PAGE = 500;
const MAX_PAGES = 4;
/** Reported ids older than this are dropped; the poll window never reaches back that far. */
const KEEP_REPORTED_DAYS = 7;

export interface Deps {
  fetch: typeof globalThis.fetch;
  apiKey: string;
}

async function getJson<T>(deps: Deps, path: string): Promise<T> {
  const res = await deps.fetch(`${API_URL}${path}`, {
    headers: { "x-api-key": deps.apiKey },
  });
  if (!res.ok)
    throw new Error(
      `GET ${path.split("?")[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  return (await res.json()) as T;
}

async function failedSince(
  deps: Deps,
  definitionId: string,
  from: Date,
  to: Date,
): Promise<Execution[]> {
  const rows: Execution[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      definitionId,
      status: "failed",
      from: from.toISOString(),
      to: to.toISOString(),
      limit: String(PAGE),
      offset: String(page * PAGE),
    });
    const got = await getJson<Execution[]>(
      deps,
      `/v1/workflows/executions?${q}`,
    );
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  return rows;
}

async function readCursor(db: Db): Promise<Date | null> {
  const rows = await db.query<{ cursor: Date }>(
    "select cursor from watchdog_state where id = 1",
  );
  return rows[0] ? new Date(rows[0].cursor) : null;
}

async function reportedAmong(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.query<{ execution_id: string }>(
    `select execution_id from watchdog_reported where execution_id in (${ids.map((_, i) => `$${i + 1}`).join(", ")})`,
    ids,
  );
  return new Set(rows.map((r) => r.execution_id));
}

const markReported = (db: Db, executionId: string, agent: string) =>
  db.query(
    "insert into watchdog_reported (execution_id, agent) values ($1, $2) on conflict do nothing",
    [executionId, agent],
  );

/** The issue the run worked on, from the `runs` table every agent writes first. */
async function issueNumberOf(
  db: Db,
  executionId: string,
): Promise<number | null> {
  const rows = await db.query<{ number: number }>(
    "select i.number from runs r join issues i on i.id = r.issue_id where r.execution_id = $1",
    [executionId],
  );
  return rows[0]?.number ?? null;
}

type TickCtx = SlackCtx & Pick<AgentExecutionContext, "executionId">;

/** One poll. Exported so tests inject `fetch` and the key. */
export async function tick(ctx: TickCtx, db: Db, deps: Deps) {
  const channel =
    (await getConfigOr(db, "alerts.channel", null)) ??
    (await getConfig(db, "channels.triage"));
  const [{ now }] = await db.query<{ now: Date }>("select now() as now");
  const to = new Date(now);
  const from = lookbackFrom(await readCursor(db), to);

  const defs = await getJson<{ id: string; slug: string }[]>(
    deps,
    "/v1/workflows/definitions?limit=200",
  );
  const watched = defs.filter((d) =>
    (WATCHED_SLUGS as readonly string[]).includes(d.slug),
  );
  const slugOf = new Map(watched.map((d) => [String(d.id), d.slug]));

  const problems: string[] = [];
  const rows: Execution[] = [];
  for (const d of watched) {
    try {
      rows.push(...(await failedSince(deps, String(d.id), from, to)));
    } catch (err) {
      problems.push(`list ${d.slug}: ${String(err)}`);
    }
  }

  const reported = await reportedAmong(
    db,
    rows.map((r) => r.id),
  );
  const fresh = newFailures(rows, reported, ctx.executionId);
  const { post: toPost, more } = splitBatch(fresh);

  const posted: string[] = [];
  for (const row of toPost) {
    const slug = slugOf.get(String(row.definitionId)) ?? row.name ?? "unknown";
    try {
      let detail: ExecutionDetail | null = null;
      try {
        detail = await getJson<ExecutionDetail>(
          deps,
          `/v1/workflows/executions/${encodeURIComponent(row.id)}`,
        );
      } catch (err) {
        // The row alone still names the agent and step; post that rather than nothing.
        ctx.logger.warn("watchdog detail failed", {
          executionId: row.id,
          err: String(err),
        });
      }
      const failure = describeFailure(
        slug,
        row,
        detail,
        await issueNumberOf(db, row.id),
      );
      const msg = failureMessage(failure);
      await post(ctx, { channel, text: msg.text, blocks: msg.blocks });
      await markReported(db, row.id, slug);
      posted.push(row.id);
    } catch (err) {
      problems.push(`report ${row.id}: ${String(err)}`);
    }
  }

  if (more.length > 0 && problems.length === 0) {
    try {
      await post(ctx, { channel, text: moreMessage(more.length) });
      for (const row of more)
        await markReported(
          db,
          row.id,
          slugOf.get(String(row.definitionId)) ?? "unknown",
        );
    } catch (err) {
      problems.push(`summary: ${String(err)}`);
    }
  }

  if (problems.length > 0) {
    // Leave the cursor: the next tick's window still covers these failures.
    ctx.logger.error("watchdog tick incomplete", { problems });
    throw new Error(`watchdog tick incomplete: ${problems.join("; ")}`);
  }

  await db.query(
    `insert into watchdog_state (id, cursor) values (1, $1)
     on conflict (id) do update set cursor = excluded.cursor`,
    [to.toISOString()],
  );
  await db.query("delete from watchdog_reported where reported_at < $1", [
    new Date(to.getTime() - KEEP_REPORTED_DAYS * 86_400_000).toISOString(),
  ]);
  return {
    channel,
    from: from.toISOString(),
    to: to.toISOString(),
    posted,
    summarized: more.length,
  };
}

/** The org key setup stored as this agent's secret; its absence means setup has not run. */
export function requireKey(env: Record<string, string | undefined>): string {
  const key = env[KEY_ENV];
  if (!key)
    throw new Error(
      `${KEY_ENV} is not set; run \`pnpm run setup --only watchdog\` in examples/sylon to provision it`,
    );
  return key;
}

const scan = defineStep({
  name: "scan",
  terminal: true,
  inputSchema: z.object({}).passthrough(),
  async run(_input, ctx) {
    // A local trace has no org key; it must not poll the live API.
    if (ctx.isLocalTrace) return terminate({ outcome: "local_trace" });
    const apiKey = requireKey(process.env);
    return withDb(ctx, async (db) =>
      terminate(await tick(ctx, db, { fetch: globalThis.fetch, apiKey })),
    );
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Sylon watchdog: a cron that posts each failed Sylon run to Slack with the failed step, the error and what to do.",
  entry: "scan",
  steps: { scan },
});
