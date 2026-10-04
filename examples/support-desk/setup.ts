/**
 * `pnpm run setup` (not `pnpm setup`, which is pnpm's own command): install the fleet in
 * fleet.json into the org that SAPIOM_API_KEY belongs to.
 *
 * Steps, each check-then-create, so a second run reports no changes and a rerun repairs a
 * partial install:
 * 1. Preflight the Slack and Linear connectors the selected projects need; stop if one is missing.
 *    Every desk's triage channel is probed. With urgent-pager selected, also check that each
 *    desk's `oncallSlackId` resolves.
 * 2. Database: resolve or create the fleet database (`DB_HANDLE`), apply migrations, seed missing desks, config keys and
 *    accounts. Desks and config come from fleet.local.json (your workspace's ids, gitignored)
 *    over fleet.json, whose values are examples; setup stops if any workspace value is still an
 *    example. A local `desks` list replaces fleet.json's whole. `--overwrite` resets every desk
 *    and config key to those values.
 * 3. Seed starter policy articles into an empty knowledge base (the Console edits it from there).
 * 4. Link and deploy each selected project (agent-core `link` / `deploy`). A project whose bundle
 *    hash and active build match `.sapiom/fleet-state.json` is left alone.
 * 5. Attach the fleet.json `triggers` that are missing, after listing the attached ones (cron
 *    triggers are not deduped server-side), and resume matching ones that are paused.
 *    `smokeTriggers` are never attached.
 * 6. Write `.sapiom/fleet-state.json` (ids and hashes only).
 *
 * Selection: every project that is neither `optional` nor `smoke`; `--only <key>` acts on exactly
 * the named projects (optional ones included), `--skip <key>` leaves one out. Both repeat.
 * `--no-triggers` deploys without attaching triggers (it never detaches one).
 *
 * Needs SAPIOM_API_KEY (an org key for the target org) in the environment. Prints no secrets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bundleForDeploy,
  createClient as createGatewayClient,
  deploy,
  link,
  writeConfig,
  type GatewayClient,
} from "@sapiom/agent-core";
import { createClient } from "@sapiom/tools";

import {
  DB_HANDLE,
  connectPostgres,
  migrate,
  resolveConnectionString,
} from "./_shared/db";
import { FLEET_ID } from "./_shared/fleet-id";
import { seedStarters } from "./_shared/kb";
import { listTools } from "./_shared/linear";
import {
  assertDistinctTriageChannels,
  exampleKeys,
  mergeConfig,
  mergeDesks,
  seedFleet,
  type FleetDesk,
} from "./_shared/seed";
import { SlackMethodError, replies, userInfo } from "./_shared/slack";
import { assertFleetIdSynced } from "./scripts/fleet-id";
import { WATCHDOG_SECRET, ensureWatchdogKey } from "./scripts/secrets";
import {
  bundleHash,
  connectorsFor,
  missingTriggers,
  parseArgs,
  pausedToResume,
  sameTrigger,
  selectProjects,
  triggerBody,
  triggerLabel,
  triggersFor,
  type AttachedTrigger,
  type FleetProject,
  type FleetState,
} from "./scripts/fleet";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.join(ROOT, "fleet.local.json");
const STATE_FILE = path.join(ROOT, ".sapiom", "fleet-state.json");
const CONNECTORS_PAGE = "https://app.sapiom.ai/connectors";

/**
 * Your workspace's ids: fleet.local.json `{ "desks": [...], "config": { ... } }` over fleet.json's
 * examples.
 */
function loadConfig() {
  const local = existsSync(LOCAL_FILE)
    ? (JSON.parse(readFileSync(LOCAL_FILE, "utf8")) as {
        desks?: FleetDesk[];
        config?: Record<string, unknown>;
      })
    : undefined;
  const values = mergeConfig(local?.config);
  const desks = mergeDesks(local?.desks, local?.config);
  assertDistinctTriageChannels(desks);
  const unset = exampleKeys(values, desks);
  if (unset.length > 0) {
    throw new Error(
      `these values still hold fleet.json's examples: ${unset.join(", ")}. ` +
        `Put your workspace's ids in fleet.local.json (gitignored), as { "desks": [{ "slug": ..., "triageChannel": ... }], "config": { "<key>": <value> } }.`,
    );
  }
  return { values, desks };
}

function loadState(): FleetState {
  if (existsSync(STATE_FILE))
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as FleetState;
  return {
    fleet: FLEET_ID,
    updatedAt: "",
    database: { handle: DB_HANDLE },
    projects: {},
    triggers: {},
  };
}

/** Every change this run made; empty means the install was already complete. */
const changes: string[] = [];
const say = (line: string) => console.log(`  ${line}`);
const changed = (line: string) => {
  changes.push(line);
  say(`+ ${line}`);
};

/** The script's own context for `_shared/slack.ts` and `_shared/linear.ts`: live, logged to the console. */
const scriptCtx = { isLocalTrace: false, logger: console } as never;

/** A thread that cannot exist; asking for it costs nothing and posts nothing. */
const PROBE_TS = "1000000000.000001";

/**
 * Slack is connected when Slack itself answers a read of the triage channel: `thread_not_found`
 * for the probe thread proves the connector reaches Slack and the bot can read the channel. It
 * does not depend on the on-call user, which only the optional urgent-pager uses.
 */
async function probeSlack(triage: string) {
  try {
    await replies(scriptCtx, { channel: triage, ts: PROBE_TS });
  } catch (err) {
    if (err instanceof SlackMethodError && /thread_not_found/.test(err.detail))
      return;
    throw err;
  }
}

async function preflight(
  selected: FleetProject[],
  desks: readonly FleetDesk[],
) {
  console.log("connectors");
  const missing: string[] = [];
  for (const c of connectorsFor(selected)) {
    try {
      if (c.provider === "slack")
        for (const d of desks) await probeSlack(d.triageChannel);
      else if (c.provider === "linear") await listTools(scriptCtx);
      else throw new Error(`setup has no preflight for '${c.provider}'`);
      say(`${c.provider}: connected`);
    } catch (err) {
      const relay = c.relaySlug
        ? ` with the MCP relay slug '${c.relaySlug}'`
        : "";
      missing.push(
        `${c.provider} (needed by ${c.requiredBy.join(", ")}): connect it${relay} at ${CONNECTORS_PAGE}. ` +
          `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (missing.length)
    throw new Error(`missing connectors:\n- ${missing.join("\n- ")}`);
  if (selected.some((p) => p.key === "urgent-pager")) {
    for (const d of desks) {
      if (!d.oncallSlackId) continue;
      const oncall = d.oncallSlackId;
      await userInfo(scriptCtx, oncall).catch((err: unknown) => {
        throw new Error(
          `urgent-pager pages desk '${d.slug}' oncallSlackId '${oncall}', which Slack cannot resolve: ` +
            `${err instanceof Error ? err.message : String(err)}. Fix it in fleet.local.json, or leave urgent-pager out.`,
        );
      });
      say(`desk ${d.slug} oncallSlackId: resolves`);
    }
  }
}

async function database(
  { values, desks }: ReturnType<typeof loadConfig>,
  overwrite: boolean,
) {
  console.log("database");
  const sapiom = createClient({ apiKey: process.env.SAPIOM_API_KEY! });
  const existed = await sapiom.database.get(DB_HANDLE).then(
    () => true,
    (err: unknown) => {
      if ((err as { status?: unknown })?.status === 404) return false;
      throw err;
    },
  );
  const { db, close } = await connectPostgres(
    await resolveConnectionString({ sapiom } as never),
  );
  try {
    if (existed) say(`${DB_HANDLE}: exists`);
    else changed(`database ${DB_HANDLE} created`);
    const applied = await migrate(db);
    if (applied.length) changed(`migrations applied: ${applied.join(", ")}`);
    else say("migrations: up to date");
    const accountsBefore = await db.query<{ n: string }>(
      "select count(*)::text as n from accounts",
    );
    const { set, kept, removed, desksSet, desksKept } = await seedFleet(
      db,
      "setup",
      { overwrite, values, desks },
    );
    if (desksSet.length) changed(`desks set: ${desksSet.join(", ")}`);
    if (desksKept.length) say(`desks kept: ${desksKept.join(", ")}`);
    if (set.length) changed(`config set: ${set.join(", ")}`);
    if (removed.length) changed(`config removed: ${removed.join(", ")}`);
    if (kept.length) say(`config kept: ${kept.join(", ")}`);
    const accounts = await db.query<{ name: string; slack_channel_id: string }>(
      "select name, slack_channel_id from accounts order by name",
    );
    if (accounts.length !== Number(accountsBefore[0].n))
      changed(
        `accounts: ${accounts.map((a) => `${a.name} (${a.slack_channel_id})`).join(", ")}`,
      );
    else say(`accounts: ${accounts.length}, unchanged`);
    const starters = await seedStarters(db);
    if (starters)
      changed(
        `knowledge base: ${starters} starter policies added (examples; edit or delete them in the Console)`,
      );
    else say("knowledge base: has articles, starters not added");
  } finally {
    await close();
  }
}

interface Definition {
  id: string;
  slug?: string;
  name: string;
  activeBuildRunId?: string | null;
  activeBuildRunStatus?: string | null;
}

/** Link (create if absent) and deploy one project, unless its bundle is what is already live. */
async function install(
  p: FleetProject,
  client: GatewayClient,
  existing: Definition[],
  state: FleetState,
): Promise<string[]> {
  const out: string[] = [];
  const dir = path.join(ROOT, p.path);
  const known = existing.some((d) => d.slug === p.slug || d.name === p.slug);
  const { definitionId, name } = await link(
    { name: p.slug, create: true },
    client,
  );
  writeConfig(dir, { definitionId, name });
  if (!known) out.push(`+ ${p.key}: created agent ${p.slug} (${definitionId})`);
  const hash = bundleHash(await bundleForDeploy(dir));
  const def = await client.get<Definition>(`/definitions/${definitionId}`);
  const last = state.projects[p.key];
  if (
    last?.bundleHash === hash &&
    last.definitionId === definitionId &&
    def.activeBuildRunId === last.buildRunId &&
    def.activeBuildRunStatus === "ready"
  ) {
    out.push(`  ${p.key}: deployed, unchanged (build ${last.buildRunId})`);
    return out;
  }
  const result = await deploy({ projectDir: dir, definitionId }, client);
  state.projects[p.key] = {
    slug: p.slug,
    definitionId,
    buildRunId: result.buildRunId,
    bundleHash: hash,
  };
  out.push(`+ ${p.key}: deployed build ${result.buildRunId}`);
  return out;
}

async function projects(
  selected: FleetProject[],
  client: GatewayClient,
  state: FleetState,
) {
  console.log("projects");
  const existing = await client.get<Definition[]>("/definitions");
  // Builds run server-side; deploying in parallel keeps a full install to about one build's time.
  const results = await Promise.allSettled(
    selected.map((p) => install(p, client, existing, state)),
  );
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled")
      for (const line of r.value)
        line.startsWith("+ ") ? changed(line.slice(2)) : say(line.trim());
    else
      failed.push(
        `${selected[i].key}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      );
  });
  if (failed.length)
    throw new Error(`deploy failed:\n- ${failed.join("\n- ")}`);
}

async function triggers(
  selected: FleetProject[],
  client: GatewayClient,
  state: FleetState,
) {
  console.log("triggers");
  const wanted = triggersFor(selected);
  for (const p of selected) {
    const mine = wanted.filter((t) => t.project === p.key);
    if (!mine.length) continue;
    const attached = await client.get<AttachedTrigger[]>(
      `/definitions/${p.slug}/triggers`,
    );
    const missing = missingTriggers(mine, attached);
    const resume = pausedToResume(mine, attached);
    for (const t of mine.filter(
      (m) => !missing.includes(m) && !resume.some((r) => r.want === m),
    ))
      say(`${triggerLabel(t)}: attached`);
    for (const { want, trigger } of resume) {
      await client.post(`/triggers/${trigger.id}/resume`, {});
      changed(`${triggerLabel(want)}: resumed (trigger ${trigger.id})`);
    }
    for (const t of missing) {
      const made = await client.post<{ id: string }>(
        `/definitions/${p.slug}/triggers`,
        triggerBody(t),
      );
      changed(`${triggerLabel(t)}: attached (trigger ${made.id})`);
    }
    const live = await client.get<AttachedTrigger[]>(
      `/definitions/${p.slug}/triggers`,
    );
    state.triggers[p.key] = mine.map((t) => ({
      id: live.find((a) => sameTrigger(t, a))?.id ?? "",
      label: triggerLabel(t),
    }));
  }
}

/** The watchdog's read-only key, set as an agent secret before its first cron tick. */
async function secrets(
  selected: FleetProject[],
  client: GatewayClient,
  state: FleetState,
) {
  const watchdog = selected.find((p) => p.key === "watchdog");
  if (!watchdog) return;
  console.log("secrets");
  const definitionId = state.projects[watchdog.key]?.definitionId;
  if (!definitionId)
    throw new Error(
      "watchdog has no deployed definition to attach a secret to",
    );
  const out = await ensureWatchdogKey(client, definitionId);
  if (out.outcome === "present") return say(`${WATCHDOG_SECRET}: set`);
  state.secrets = {
    ...state.secrets,
    [watchdog.key]: {
      name: WATCHDOG_SECRET,
      keyId: out.keyId,
      at: new Date().toISOString(),
    },
  };
  changed(`${WATCHDOG_SECRET}: provisioned a read-only key for the watchdog`);
}

async function main() {
  assertFleetIdSynced(FLEET_ID);
  const args = parseArgs(process.argv.slice(2));
  const selected = selectProjects(args);
  const config = loadConfig();
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  console.log(`${FLEET_ID} setup: ${selected.map((p) => p.key).join(", ")}`);

  await preflight(selected, config.desks);
  await database(config, args.overwrite);
  const client = createGatewayClient({ apiKey });
  const state = loadState();
  try {
    await projects(selected, client, state);
    await secrets(selected, client, state);
    if (args.noTriggers) console.log("triggers\n  skipped (--no-triggers)");
    else await triggers(selected, client, state);
  } finally {
    state.updatedAt = new Date().toISOString();
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  }

  console.log(
    changes.length
      ? `\n${changes.length} change(s):\n${changes.map((c) => `- ${c}`).join("\n")}`
      : "\nno changes: the fleet is installed",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
