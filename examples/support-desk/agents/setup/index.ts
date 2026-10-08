/**
 * setup: the install steps that need the fleet database or the org's connectors, as an agent, so an
 * Agent Studio or MCP install runs them with the run's own credential instead of an org API key.
 * `pnpm run setup` stays the CLI path and does the same database and connector work.
 *
 * Not a fleet agent: no trigger, run by hand (`sapiom_dev_agents_run`), as often as needed.
 *
 *   database ─── connectors
 *
 * - `database`: resolve or create the fleet database, apply migrations, and, when the input has
 *   `desks` or `config`, seed them plus the starter articles into an empty knowledge base. Desks
 *   and unnamed config keys are check-then-create, like setup; a config key named in the input is
 *   always written; `overwrite` resets everything to the input over fleet.json. Refuses
 *   fleet.json's example ids.
 * - `connectors`: read every desk's triage channel and every customer channel through the Slack
 *   connector, resolve each on-call user, and list the Linear teams and projects the connector can
 *   see, so their ids can be picked.
 *
 * The output is a report: what the database holds, every check with its fix, the Linear ids, and
 * the next steps. Nothing is posted to Slack or written to Linear.
 */
import {
  defineAgent,
  defineStep,
  goto,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";

import {
  ConfigSchemas,
  getConfigOr,
  setConfig,
  type ConfigKey,
} from "../../_shared/config";
import {
  DB_HANDLE,
  connectPostgres,
  migrate,
  resolveConnectionString,
  withDb,
  type Db,
} from "../../_shared/db";
import { listDesks } from "../../_shared/desks";
import { agentSlug } from "../../_shared/fleet-id";
import { countArticles, seedStarters } from "../../_shared/kb";
import { callTool, listTools } from "../../_shared/linear";
import {
  exampleKeys,
  mergeConfig,
  seedFleet,
  type FleetConfigValues,
} from "../../_shared/seed";
import { replies, userInfo, type SlackCtx } from "../../_shared/slack";
import {
  SetupInput,
  channelCheck,
  configErrors,
  linearCheck,
  nextSteps,
  parseProjects,
  parseTeams,
  userCheck,
  type Check,
  type LinearProject,
  type LinearTeam,
} from "./logic";

export const AGENT = agentSlug("setup");
/** Recorded as `set_by` on the config rows this agent writes. */
const SET_BY = "setup-agent";

type Ctx = AgentExecutionContext<Record<string, unknown>>;

/** A thread that cannot exist; asking for it costs nothing and posts nothing. */
const PROBE_TS = "1000000000.000001";
/** Bounds one run's Slack calls; customer channels past it are not probed. */
const MAX_CHANNEL_PROBES = 50;

export interface DatabaseReport {
  handle: string;
  created: boolean;
  migrationsApplied: string[];
  seeded: {
    set: string[];
    kept: string[];
    removed: string[];
    desksSet: string[];
    desksKept: string[];
    starterArticles: number;
  } | null;
  desks: {
    slug: string;
    name: string;
    triageChannel: string;
    linearTeamId: string | null;
    linearProjectId: string | null;
    oncallSlackId: string | null;
    isDefault: boolean;
  }[];
  customerChannels: number;
  articles: number;
  docsUrl: string | null;
}

/**
 * Deployed: open the fleet database directly so the report can say whether it was created and
 * which migrations ran. A local trace uses the in-memory database every agent's trace gets.
 */
async function withSetupDb<R>(
  ctx: Ctx,
  fn: (db: Db, info: { created: boolean; applied: string[] }) => Promise<R>,
): Promise<R> {
  if (ctx.isLocalTrace)
    return withDb(ctx, (db) => fn(db, { created: false, applied: [] }));
  const existed = await ctx.sapiom.database.get(DB_HANDLE).then(
    () => true,
    (err: unknown) => {
      if ((err as { status?: unknown })?.status === 404) return false;
      throw err;
    },
  );
  const { db, close } = await connectPostgres(
    await resolveConnectionString(ctx),
  );
  try {
    const applied = await migrate(db);
    return await fn(db, { created: !existed, applied });
  } finally {
    await close();
  }
}

/** Seed when the input asks to, then describe what the database holds. */
export async function prepareDatabase(
  db: Db,
  input: SetupInput,
): Promise<Omit<DatabaseReport, "handle" | "created" | "migrationsApplied">> {
  let seeded: DatabaseReport["seeded"] = null;
  if (input.desks !== undefined || input.config !== undefined) {
    const errors = configErrors(input.config ?? {});
    if (errors.length) throw new Error(errors.join("; "));
    const desks = (input.desks ?? []).map((d) => ({ ...d }));
    if (!desks.length && !(await listDesks(db)).length)
      throw new Error(
        'the database has no desk yet: pass "desks", e.g. [{ "slug": "support", "name": "Support", "triageChannel": "C…", "default": true }]',
      );
    const values = mergeConfig(
      input.config as Partial<FleetConfigValues> | undefined,
    );
    // Without overwrite, a key the input omits keeps its stored value: check that value for
    // fleet.json's examples and seed accounts from it, not fleet.json's placeholder.
    if (!input.overwrite)
      for (const row of await db.query<{ key: string; value: unknown }>(
        "select key, value from config",
      ))
        if (row.key in ConfigSchemas && !(row.key in (input.config ?? {})))
          values[row.key as ConfigKey] = row.value;
    const examples = exampleKeys(values, desks);
    if (examples.length)
      throw new Error(
        `these values still hold fleet.json's examples: ${examples.join(", ")}. ` +
          `Pass your workspace's ids (for no customer channels yet: "config": { "channels.customer": [] }).`,
      );
    const out = await seedFleet(db, SET_BY, {
      overwrite: input.overwrite,
      values,
      desks,
    });
    // A key named in the input is meant, so it is written even where seeding kept the old value.
    for (const key of Object.keys(input.config ?? {}) as ConfigKey[]) {
      if (!out.kept.includes(key)) continue;
      await setConfig(db, key, values[key] as never, SET_BY);
      out.kept = out.kept.filter((k) => k !== key);
      out.set.push(key);
    }
    seeded = { ...out, starterArticles: await seedStarters(db) };
  }
  const desks = await listDesks(db);
  return {
    seeded,
    desks: desks.map((d) => ({
      slug: d.slug,
      name: d.name,
      triageChannel: d.triageChannel,
      linearTeamId: d.linearTeamId,
      linearProjectId: d.linearProjectId,
      oncallSlackId: d.oncallSlackId,
      isDefault: d.isDefault,
    })),
    customerChannels: (await getConfigOr(db, "channels.customer", [])).length,
    articles: await countArticles(db),
    docsUrl: await getConfigOr(db, "knowledge.docs_url", null),
  };
}

async function probeChannel(
  ctx: SlackCtx,
  channel: string,
): Promise<unknown | null> {
  try {
    await replies(ctx, { channel, ts: PROBE_TS });
    return null;
  } catch (err) {
    return err;
  }
}

/** Every desk's triage channel and on-call user, then every customer channel. */
export async function probeSlack(ctx: SlackCtx, db: Db): Promise<Check[]> {
  const checks: Check[] = [];
  for (const d of await listDesks(db)) {
    checks.push(
      channelCheck(
        `desk ${d.slug} triage channel ${d.triageChannel}`,
        d.triageChannel,
        await probeChannel(ctx, d.triageChannel),
      ),
    );
    if (d.oncallSlackId) {
      const target = `desk ${d.slug} on-call ${d.oncallSlackId}`;
      try {
        checks.push(
          userCheck(
            target,
            d.oncallSlackId,
            await userInfo(ctx, d.oncallSlackId),
            null,
          ),
        );
      } catch (err) {
        checks.push(userCheck(target, d.oncallSlackId, null, err));
      }
    }
  }
  const customers = await getConfigOr(db, "channels.customer", []);
  for (const c of customers.slice(0, MAX_CHANNEL_PROBES))
    checks.push(
      channelCheck(
        `customer channel ${c.accountName} ${c.channelId}`,
        c.channelId,
        await probeChannel(ctx, c.channelId),
      ),
    );
  return checks;
}

/** The Linear connector's check, and its teams and projects when it is connected. */
export async function probeLinear(ctx: SlackCtx): Promise<{
  check: Check;
  linear: { teams: LinearTeam[]; projects: LinearProject[] } | null;
}> {
  // `listTools` has no local stub; a local trace never reaches the network.
  if (ctx.isLocalTrace)
    return {
      check: {
        target: "linear connector",
        ok: true,
        detail: "not probed on a local trace",
      },
      linear: { teams: [], projects: [] },
    };
  let names: string[];
  try {
    names = (await listTools(ctx)).map((t) => t.name);
  } catch (err) {
    return { check: linearCheck(err, 0), linear: null };
  }
  const failures: string[] = [];
  const list = async (tool: string) => {
    if (!names.includes(tool)) {
      failures.push(`${tool} is not offered`);
      return null;
    }
    try {
      return await callTool(tool, {}, ctx);
    } catch (err) {
      ctx.logger.warn(`linear ${tool} failed`, { err: String(err) });
      failures.push(`${tool} failed: ${String(err)}`);
      return null;
    }
  };
  // Partial results stay: a failed project listing still leaves the team ids usable.
  const linear = {
    teams: parseTeams(await list("list_teams")),
    projects: parseProjects(await list("list_projects")),
  };
  return { check: linearCheck(null, names.length, failures), linear };
}

const database = defineStep({
  name: "database",
  next: ["connectors"],
  inputSchema: SetupInput,
  async run(input, ctx) {
    const report = await withSetupDb(ctx, async (db, info) => ({
      handle: DB_HANDLE,
      created: info.created,
      migrationsApplied: info.applied,
      ...(await prepareDatabase(db, input)),
    }));
    return goto("connectors", { database: report });
  },
});

const connectors = defineStep({
  name: "connectors",
  terminal: true,
  // No inputSchema: the payload is the database step's own report, and z.custom has no JSON
  // Schema form, so the deploy build rejected it.
  async run({ database: db }: { database: DatabaseReport }, ctx) {
    const slack = await withDb(ctx, (d) => probeSlack(ctx, d));
    const { check, linear } = await probeLinear(ctx);
    const checks = [...slack, check];
    return terminate({
      database: db,
      checks,
      linear,
      next: nextSteps({
        desks: db.desks,
        checks,
        linear,
        docsUrl: db.docsUrl,
      }),
    });
  },
});

export const agent = defineAgent({
  name: AGENT,
  description:
    "Support desk setup: creates and migrates the fleet database, seeds desks and config, probes Slack and Linear, and lists Linear ids. Run by hand.",
  entry: "database",
  steps: { database, connectors },
});
