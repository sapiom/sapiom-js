/**
 * The setup agent's pure half: its input, how a probe error reads as a fix, how Linear's
 * `list_teams` / `list_projects` output becomes ids to pick, and the next steps the report ends
 * with. No I/O, so the tests cover it directly.
 */
import { z } from "zod/v4";

import { ConfigSchemas, type ConfigKey } from "../../_shared/config";
import { SlackMethodError } from "../../_shared/slack";

/** A desk as fleet.local.json writes it (`default` marks the default desk). */
export const SetupDesk = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase words and -"),
    name: z.string().trim().min(1),
    triageChannel: z
      .string()
      .regex(/^[CG][A-Z0-9]{2,}$/, "must be a Slack channel id (C…)"),
    linearTeamId: z.string().trim().min(1).optional(),
    linearProjectId: z.string().trim().min(1).optional(),
    oncallSlackId: z
      .string()
      .regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack user id (U…)")
      .optional(),
    nudgeMinutes: z.number().int().positive().optional(),
    default: z.boolean().optional(),
  })
  .strict();
export type SetupDesk = z.infer<typeof SetupDesk>;

/**
 * The run's input. Everything is optional: `{}` creates or migrates the database, reports what it
 * holds, probes the connectors and lists Linear teams and projects. `desks` and `config` seed.
 */
export const SetupInput = z
  .object({
    /** Desks to seed. A desk that already exists is kept unless `overwrite`. */
    desks: z.array(SetupDesk).optional(),
    /** Config keys by `_shared/config.ts` name, over fleet.json's values. Named keys are always written. */
    config: z.record(z.string(), z.unknown()).optional(),
    /** Reset the given desks and every config key to the input (and fleet.json for the rest). */
    overwrite: z.boolean().default(false),
  })
  .strict();
export type SetupInput = z.infer<typeof SetupInput>;

/** Config keys in the input that `_shared/config.ts` does not define, or values its schema rejects. */
export function configErrors(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!(key in ConfigSchemas)) {
      errors.push(`config '${key}' is not a config key`);
      continue;
    }
    const parsed = ConfigSchemas[key as ConfigKey].safeParse(value);
    if (!parsed.success)
      errors.push(
        `config '${key}': ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
  }
  return errors;
}

/** One connector check: what was probed, whether it works, and the fix when it does not. */
export interface Check {
  target: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const detailOf = (err: unknown) =>
  err instanceof SlackMethodError
    ? err.detail
    : err instanceof Error
      ? err.message
      : String(err);

/**
 * A channel probe's outcome. The probe reads a thread that cannot exist, so Slack answering
 * `thread_not_found` proves the bot can read the channel.
 */
export function channelCheck(
  target: string,
  channel: string,
  err: unknown | null,
): Check {
  if (err === null) return { target, ok: true, detail: "readable" };
  const detail = detailOf(err);
  if (/thread_not_found/.test(detail))
    return { target, ok: true, detail: "readable" };
  if (/not_in_channel/.test(detail))
    return {
      target,
      ok: false,
      detail: "the Slack bot is not a member",
      fix: `Invite the Sapiom Slack bot to ${channel} (in the channel: /invite and pick the bot). Slack sends nothing for a channel the bot is not in, so this fails silently.`,
    };
  if (/channel_not_found/.test(detail))
    return {
      target,
      ok: false,
      detail: "channel not found",
      fix: `Check the id ${channel} (channel details, bottom of the About tab). A private channel also reads as not found until the bot is invited.`,
    };
  if (/missing_scope|invalid_auth|not_authed|account_inactive/.test(detail))
    return {
      target,
      ok: false,
      detail,
      fix: "Reconnect Slack on the Sapiom Connectors page.",
    };
  if (/\b(401|403|404)\b|not connected|no connection/i.test(detail))
    return {
      target,
      ok: false,
      detail,
      fix: "Connect Slack on the Sapiom Connectors page.",
    };
  return { target, ok: false, detail };
}

export function userCheck(
  target: string,
  user: string,
  found: { name: string } | null,
  err: unknown | null,
): Check {
  if (found) return { target, ok: true, detail: `resolves to ${found.name}` };
  return {
    target,
    ok: false,
    detail: detailOf(err),
    fix: `Check the Slack user id ${user} (profile, More, Copy member ID).`,
  };
}

export function linearCheck(err: unknown | null, tools: number): Check {
  if (err === null)
    return {
      target: "linear connector",
      ok: true,
      detail: `connected (${tools} tools)`,
    };
  return {
    target: "linear connector",
    ok: false,
    detail: detailOf(err),
    fix: "Connect Linear on the Sapiom Connectors page with the MCP relay slug 'linear'.",
  };
}

export interface LinearTeam {
  id: string;
  name: string;
  key?: string;
}
export interface LinearProject {
  id: string;
  name: string;
  teams: string[];
}

const LIST_KEYS = ["teams", "projects", "nodes", "items", "results", "data"];

/** The array in a Linear MCP list response: the response itself, or under a common key. */
function listOf(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object")
    for (const k of LIST_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
      if (v && typeof v === "object") {
        const inner = listOf(v);
        if (inner.length) return inner;
      }
    }
  return [];
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function parseTeams(raw: unknown): LinearTeam[] {
  return listOf(raw).flatMap((t) => {
    const id = str(t.id) ?? str(t.uuid);
    const name = str(t.name);
    return id && name
      ? [{ id, name, ...(str(t.key) && { key: str(t.key) }) }]
      : [];
  });
}

/** A project's teams may be names, ids, or objects with either. */
function teamNames(p: Record<string, unknown>): string[] {
  const raw = p.teams ?? (p.team ? [p.team] : []);
  return (Array.isArray(raw) ? raw : [])
    .map((t) =>
      typeof t === "string"
        ? t
        : (str((t as Record<string, unknown>)?.name) ??
          str((t as Record<string, unknown>)?.key) ??
          str((t as Record<string, unknown>)?.id)),
    )
    .filter((t): t is string => Boolean(t));
}

export function parseProjects(raw: unknown): LinearProject[] {
  return listOf(raw).flatMap((p) => {
    const id = str(p.id) ?? str(p.uuid);
    const name = str(p.name);
    return id && name ? [{ id, name, teams: teamNames(p) }] : [];
  });
}

/** What the report says to do next, from the checks that failed and the gaps it found. */
export function nextSteps(report: {
  desks: { slug: string; linearTeamId: string | null }[];
  checks: Check[];
  linear: { teams: LinearTeam[] } | null;
  docsUrl: string | null;
}): string[] {
  const steps: string[] = [];
  if (report.desks.length === 0)
    steps.push(
      'Run this agent again with { "desks": [{ "slug": "support", "name": "Support", "triageChannel": "C…", "default": true }], "config": { "channels.customer": [] } } to seed your first desk.',
    );
  for (const c of report.checks)
    if (!c.ok) steps.push(`${c.target}: ${c.fix ?? c.detail}`);
  const noTeam = report.desks.filter((d) => !d.linearTeamId);
  if (noTeam.length && report.linear?.teams.length)
    steps.push(
      `Escalation needs a Linear team on ${noTeam.map((d) => d.slug).join(", ")}: pick an id from linear.teams and set linearTeamId (Console Settings, or rerun with the desk and "overwrite": true).`,
    );
  if (!report.docsUrl)
    steps.push(
      "Optional: set knowledge.docs_url (Console Knowledge tab) to a docs site that publishes llms.txt, so drafts can cite your public docs.",
    );
  return steps;
}
