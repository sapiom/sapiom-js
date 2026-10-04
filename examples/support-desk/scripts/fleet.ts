/**
 * The pure half of `pnpm run setup`: which projects, connectors and triggers a run acts on, and
 * how a trigger in fleet.json is matched against the ones already attached. No I/O, so the
 * selection and dedup rules are unit-tested (`fleet.test.ts`).
 */
import { createHash } from "node:crypto";

import fleet from "../fleet.json";
import { agentSlug } from "../_shared/fleet-id";

export interface FleetProject {
  key: string;
  path: string;
  slug: string;
  /** Deployed only when named with `--only` (the live-added agent). */
  optional?: boolean;
  /** E2's pipe test; never deployed by default, and its triggers live in `smokeTriggers`. */
  smoke?: boolean;
  /** Run by hand, never triggered (agents/setup): deployed only when named with `--only`. */
  manual?: boolean;
}

export type FleetTrigger =
  | { project: string; kind: "event"; eventType: string }
  | {
      project: string;
      kind: "schedule_cron";
      cron: string;
      /** IANA zone the cron runs in; unset means UTC, as on the server. */
      timezone?: string;
    };

export interface FleetConnector {
  provider: string;
  relaySlug?: string;
  requiredBy: string[];
}

/** A trigger as `GET /v1/workflows/definitions/<slug>/triggers` lists it. */
export interface AttachedTrigger {
  id: string;
  kind: string;
  status: string;
  eventType: string | null;
  cron: string | null;
  timezone?: string | null;
}

/** fleet.json's projects, each with its deployed slug: `<fleetId>-<key>`. */
export const PROJECTS: FleetProject[] = fleet.projects.map((p) => ({
  ...(p as Omit<FleetProject, "slug">),
  slug: agentSlug(p.key),
}));
export const TRIGGERS = fleet.triggers as FleetTrigger[];
export const CONNECTORS = fleet.connectors as FleetConnector[];

export interface SetupArgs {
  only: string[];
  skip: string[];
  overwrite: boolean;
  /** Deploy only: attach no triggers (a project kept quiet, such as the controller before a demo). */
  noTriggers: boolean;
}

/** `--only <key>` and `--skip <key>` repeat; `--only a,b` also works. */
export function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = {
    only: [],
    skip: [],
    overwrite: false,
    noTriggers: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--overwrite") out.overwrite = true;
    else if (a === "--no-triggers") out.noTriggers = true;
    else if (a === "--only" || a === "--skip") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a project key`);
      out[a === "--only" ? "only" : "skip"].push(...v.split(","));
    } else throw new Error(`unknown argument '${a}'`);
  }
  return out;
}

/**
 * Projects this run links and deploys. Default: every project that is not optional, smoke or manual.
 * `--only` names exactly the projects to act on (optional ones included); `--skip` removes some.
 */
export function selectProjects(
  args: Pick<SetupArgs, "only" | "skip">,
  projects: FleetProject[] = PROJECTS,
): FleetProject[] {
  const keys = new Set(projects.map((p) => p.key));
  for (const k of [...args.only, ...args.skip])
    if (!keys.has(k))
      throw new Error(
        `no project '${k}' in fleet.json (have: ${[...keys].join(", ")})`,
      );
  const base = args.only.length
    ? projects.filter((p) => args.only.includes(p.key))
    : projects.filter((p) => !p.optional && !p.smoke && !p.manual);
  return base.filter((p) => !args.skip.includes(p.key));
}

/** Connectors that at least one selected project needs. */
export function connectorsFor(
  selected: FleetProject[],
  connectors: FleetConnector[] = CONNECTORS,
): FleetConnector[] {
  const keys = new Set(selected.map((p) => p.key));
  return connectors.filter((c) => c.requiredBy.some((k) => keys.has(k)));
}

/** fleet.json `triggers` for the selected projects. `smokeTriggers` are never attached. */
export function triggersFor(
  selected: FleetProject[],
  triggers: FleetTrigger[] = TRIGGERS,
): FleetTrigger[] {
  const keys = new Set(selected.map((p) => p.key));
  return triggers.filter((t) => keys.has(t.project));
}

/** A disabled trigger is a deleted one; anything else (active, paused) is attached. */
export function sameTrigger(
  want: FleetTrigger,
  have: AttachedTrigger,
): boolean {
  if (have.status === "disabled" || have.kind !== want.kind) return false;
  return want.kind === "event"
    ? have.eventType === want.eventType
    : have.cron === want.cron &&
        (have.timezone ?? "UTC") === (want.timezone ?? "UTC");
}

/**
 * Triggers to create for one project. Listing first matters for cron: the server dedups an event
 * trigger (409) but would happily attach a second identical cron.
 */
export function missingTriggers(
  wanted: FleetTrigger[],
  attached: AttachedTrigger[],
): FleetTrigger[] {
  return wanted.filter((w) => !attached.some((a) => sameTrigger(w, a)));
}

/**
 * Triggers fleet.json used to attach and no longer does. Setup otherwise never detaches a trigger,
 * but one of these would keep firing into an entry step that no longer accepts its input.
 */
export const RETIRED_TRIGGERS: readonly FleetTrigger[] = [
  // The watchdog's poll, replaced by `sapiom.run.failed`.
  { project: "watchdog", kind: "schedule_cron", cron: "*/5 * * * *" },
];

/** One project's attached triggers that match a retired one; a disabled trigger is already gone. */
export function retiredToDetach(
  project: string,
  attached: AttachedTrigger[],
  retired: readonly FleetTrigger[] = RETIRED_TRIGGERS,
): AttachedTrigger[] {
  return retired
    .filter((r) => r.project === project)
    .flatMap((r) => attached.filter((a) => sameTrigger(r, a)));
}

/**
 * Paused triggers to resume: for each wanted trigger with no active match, a paused one that
 * matches it. A pause (by the Console, or after repeated failures) would otherwise leave the agent
 * quiet while setup reported its trigger as attached.
 */
export function pausedToResume(
  wanted: FleetTrigger[],
  attached: AttachedTrigger[],
): { want: FleetTrigger; trigger: AttachedTrigger }[] {
  return wanted.flatMap((want) => {
    const matches = attached.filter((a) => sameTrigger(want, a));
    if (matches.some((a) => a.status !== "paused")) return [];
    const paused = matches.find((a) => a.status === "paused");
    return paused ? [{ want, trigger: paused }] : [];
  });
}

export function triggerLabel(t: FleetTrigger): string {
  return t.kind === "event"
    ? `${t.project} ← ${t.eventType}`
    : `${t.project} ← cron ${t.cron}${t.timezone ? ` ${t.timezone}` : ""}`;
}

export function triggerBody(t: FleetTrigger): Record<string, string> {
  return t.kind === "event"
    ? { kind: t.kind, eventType: t.eventType }
    : t.timezone
      ? { kind: t.kind, cron: t.cron, timezone: t.timezone }
      : { kind: t.kind, cron: t.cron };
}

/** Identity of what a deploy would push: the bundled code and its pinned dependencies. */
export function bundleHash(bundle: {
  code: string;
  dependencies: Record<string, string>;
}): string {
  const deps = Object.keys(bundle.dependencies)
    .sort()
    .map((k) => `${k}@${bundle.dependencies[k]}`)
    .join("\n");
  return createHash("sha256")
    .update(bundle.code)
    .update("\0")
    .update(deps)
    .digest("hex");
}

/** `.sapiom/fleet-state.json`: what setup last installed. Ids and hashes only, never a key. */
export interface FleetState {
  fleet: string;
  updatedAt: string;
  database: { handle: string };
  projects: Record<
    string,
    {
      slug: string;
      definitionId: string;
      buildRunId: string;
      bundleHash: string;
    }
  >;
  triggers: Record<string, { id: string; label: string }[]>;
}
