/**
 * `pnpm run setup` (not `pnpm setup`, which is pnpm's own command): install the fleet in
 * fleet.json into the org that SAPIOM_API_KEY belongs to.
 *
 * Steps, each check-then-create, so a second run reports no changes and a rerun repairs a
 * partial install:
 * 1. Preflight the Slack and Linear connectors the selected projects need; stop if one is missing.
 * 2. Database: resolve or create `sylon`, apply migrations, seed missing config keys and accounts.
 *    Config comes from fleet.local.json (your workspace's ids, gitignored) merged over fleet.json,
 *    whose values are examples; setup stops if any workspace key is still an example.
 *    `--overwrite` resets every config key to those values.
 * 3. `build:kb`: regenerate `_shared/kb.generated.ts` when `kb/` changed.
 * 4. Link and deploy each selected project (agent-core `link` / `deploy`). A project whose bundle
 *    hash and active build match `.sapiom/fleet-state.json` is left alone.
 * 5. Attach the fleet.json `triggers` that are missing, after listing the attached ones (cron
 *    triggers are not deduped server-side). `smokeTriggers` are never attached.
 * 6. Write `.sapiom/fleet-state.json` (ids and hashes only).
 *
 * Selection: every project that is neither `optional` nor `smoke`; `--only <key>` acts on exactly
 * the named projects (optional ones included), `--skip <key>` leaves one out. Both repeat.
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
import { listTools } from "./_shared/linear";
import { exampleKeys, mergeConfig, seedFleet } from "./_shared/seed";
import { userInfo } from "./_shared/slack";
import { KB_OUT, readKb, renderKb } from "./scripts/build-kb";
import {
  bundleHash,
  connectorsFor,
  missingTriggers,
  parseArgs,
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

/** Your workspace's ids: fleet.local.json `{ "config": { ... } }` over fleet.json's examples. */
function loadConfig() {
  const local = existsSync(LOCAL_FILE)
    ? (
        JSON.parse(readFileSync(LOCAL_FILE, "utf8")) as {
          config?: Record<string, unknown>;
        }
      ).config
    : undefined;
  const values = mergeConfig(local);
  const unset = exampleKeys(values);
  if (unset.length > 0) {
    throw new Error(
      `these config keys still hold fleet.json's example values: ${unset.join(", ")}. ` +
        `Put your workspace's ids in fleet.local.json (gitignored), as { "config": { "<key>": <value> } }.`,
    );
  }
  return values;
}

function loadState(): FleetState {
  if (existsSync(STATE_FILE))
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as FleetState;
  return {
    fleet: "sylon",
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

async function preflight(selected: FleetProject[], oncall: string) {
  console.log("connectors");
  const missing: string[] = [];
  for (const c of connectorsFor(selected)) {
    try {
      if (c.provider === "slack") await userInfo(scriptCtx, oncall);
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
}

async function database(
  values: ReturnType<typeof loadConfig>,
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
    const { set, kept } = await seedFleet(db, "setup", { overwrite, values });
    if (set.length) changed(`config set: ${set.join(", ")}`);
    if (kept.length) say(`config kept: ${kept.join(", ")}`);
    const accounts = await db.query<{ name: string; slack_channel_id: string }>(
      "select name, slack_channel_id from accounts order by name",
    );
    if (accounts.length !== Number(accountsBefore[0].n))
      changed(
        `accounts: ${accounts.map((a) => `${a.name} (${a.slack_channel_id})`).join(", ")}`,
      );
    else say(`accounts: ${accounts.length}, unchanged`);
  } finally {
    await close();
  }
}

function buildKb() {
  console.log("kb");
  const pages = readKb();
  const next = renderKb(pages);
  if (existsSync(KB_OUT) && readFileSync(KB_OUT, "utf8") === next)
    say(`kb.generated.ts: up to date (${pages.length} pages)`);
  else {
    writeFileSync(KB_OUT, next);
    changed(`kb.generated.ts rebuilt (${pages.length} pages)`);
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
    for (const t of mine.filter((m) => !missing.includes(m)))
      say(`${triggerLabel(t)}: attached`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = selectProjects(args);
  const values = loadConfig();
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey)
    throw new Error("set SAPIOM_API_KEY to an org key for the target org");
  console.log(`sylon setup: ${selected.map((p) => p.key).join(", ")}`);

  await preflight(selected, values["oncall.slack_id"] as string);
  await database(values, args.overwrite);
  buildKb();
  const client = createGatewayClient({ apiKey });
  const state = loadState();
  try {
    await projects(selected, client, state);
    await triggers(selected, client, state);
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
