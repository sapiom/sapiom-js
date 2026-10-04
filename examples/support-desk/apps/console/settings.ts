/**
 * The Settings tab: the selected desk's row in `desks`, and the fleet-wide config keys an operator
 * tunes. Also the Knowledge tab's docs source (`knowledge.docs_url`), which is fleet-wide config too. Every value is validated before it is written (the desk fields here, the config keys by
 * their `_shared/config.ts` schemas), and the agents read both on their next run, so a change needs
 * no redeploy. Injecting Db lets specs exercise real SQL on pg-mem without starting the server.
 */
import { z } from "zod/v4";

import {
  ConfigSchemas,
  deleteConfig,
  getConfigOr,
  setConfig,
} from "../../_shared/config";
import type { Db } from "../../_shared/db";
import { parseDocsSource } from "../../_shared/docs";
import {
  deskBySlug,
  setDefaultDesk,
  upsertDesk,
  type Desk,
} from "../../_shared/desks";
import { DEFAULT_SLA_HOURS } from "../../agents/digest/logic";
import { TRIGGERS } from "./logic";

const EDITOR = "console";

/** The desk fields the form edits; each is optional, so a save sends only what changed. */
export const DeskSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    triageChannel: z
      .string()
      .regex(/^[CG][A-Z0-9]{2,}$/, "must be a Slack channel id (C…)"),
    linearTeamId: z.string().trim().min(1).nullable(),
    linearProjectId: z.string().trim().min(1).nullable(),
    oncallSlackId: z
      .string()
      .regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack user id (U…)")
      .nullable(),
    nudgeMinutes: z.number().int().positive(),
    isDefault: z.literal(true),
  })
  .partial()
  .strict();

/** The fleet-wide keys; `null` removes a key so its reader falls back to the default. */
export const FleetSettingsSchema = z
  .object({
    "nudge.repeat_minutes": ConfigSchemas["nudge.repeat_minutes"].nullable(),
    "digest.sla_hours": ConfigSchemas["digest.sla_hours"].nullable(),
    "linear_sync.notify_customer": ConfigSchemas["linear_sync.notify_customer"],
  })
  .partial()
  .strict();

/** The controller's gaps when `nudge.repeat_minutes` is unset (agents/controller). */
export const DEFAULT_REPEAT_MINUTES = [60, 240];

type Result = { status: number; body: unknown };

const invalid = (error: z.ZodError): Result => ({
  status: 400,
  body: {
    error: error.issues
      .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
      .join("; "),
  },
});

/** The digest's cron trigger from fleet.json; shown, not edited (it changes by setup). */
export function digestSchedule(): {
  cron: string;
  timezone: string | null;
} | null {
  for (const t of TRIGGERS)
    if (t.project === "digest" && t.kind === "schedule_cron")
      return { cron: t.cron, timezone: t.timezone ?? null };
  return null;
}

export async function getSettings(db: Db, desk: Desk): Promise<Result> {
  return {
    status: 200,
    body: {
      desk: {
        slug: desk.slug,
        name: desk.name,
        triageChannel: desk.triageChannel,
        linearTeamId: desk.linearTeamId,
        linearProjectId: desk.linearProjectId,
        oncallSlackId: desk.oncallSlackId,
        nudgeMinutes: desk.nudgeMinutes,
        isDefault: desk.isDefault,
      },
      fleet: {
        "nudge.repeat_minutes": await getConfigOr(
          db,
          "nudge.repeat_minutes",
          null,
        ),
        "digest.sla_hours": await getConfigOr(db, "digest.sla_hours", null),
        "linear_sync.notify_customer": await getConfigOr(
          db,
          "linear_sync.notify_customer",
          false,
        ),
      },
      defaults: {
        "nudge.repeat_minutes": DEFAULT_REPEAT_MINUTES,
        "digest.sla_hours": DEFAULT_SLA_HOURS,
      },
      digest: digestSchedule(),
    },
  };
}

export async function putDeskSettings(
  db: Db,
  desk: Desk,
  body: unknown,
): Promise<Result> {
  const parsed = DeskSettingsSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const { isDefault, ...fields } = parsed.data;
  if (Object.keys(fields).length) {
    if (
      fields.triageChannel &&
      fields.triageChannel !== desk.triageChannel &&
      (
        await db.query("select 1 from desks where triage_channel = $1", [
          fields.triageChannel,
        ])
      ).length
    )
      return {
        status: 409,
        body: {
          error: "triageChannel: another desk already uses that channel",
        },
      };
    await upsertDesk(
      db,
      {
        slug: desk.slug,
        name: fields.name ?? desk.name,
        triageChannel: fields.triageChannel ?? desk.triageChannel,
        linearTeamId:
          fields.linearTeamId !== undefined
            ? fields.linearTeamId
            : desk.linearTeamId,
        linearProjectId:
          fields.linearProjectId !== undefined
            ? fields.linearProjectId
            : desk.linearProjectId,
        oncallSlackId:
          fields.oncallSlackId !== undefined
            ? fields.oncallSlackId
            : desk.oncallSlackId,
        nudgeMinutes: fields.nudgeMinutes ?? desk.nudgeMinutes,
        // Kept here; becoming the default goes through setDefaultDesk, which clears the old one.
        isDefault: desk.isDefault,
      },
      { overwrite: true },
    );
  }
  if (isDefault && !desk.isDefault) await setDefaultDesk(db, desk.slug);
  const saved = await deskBySlug(db, desk.slug);
  return getSettings(db, saved ?? desk);
}

/** The docs site the copilot reads, or null; `null` in a PUT removes it. */
export const DocsSourceSchema = z
  .object({ docsUrl: ConfigSchemas["knowledge.docs_url"].nullable() })
  .strict();

/** The configured docs site and the `llms.txt` the copilot reads from it. */
export async function getDocsSource(db: Db): Promise<Result> {
  const docsUrl = await getConfigOr(db, "knowledge.docs_url", null);
  return {
    status: 200,
    body: {
      docsUrl,
      indexUrl: docsUrl ? parseDocsSource(docsUrl).indexUrl : null,
    },
  };
}

export async function putDocsSource(db: Db, body: unknown): Promise<Result> {
  const parsed = DocsSourceSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const { docsUrl } = parsed.data;
  if (docsUrl === null) await deleteConfig(db, "knowledge.docs_url");
  else await setConfig(db, "knowledge.docs_url", docsUrl, EDITOR);
  return getDocsSource(db);
}

export async function putFleetSettings(
  db: Db,
  desk: Desk,
  body: unknown,
): Promise<Result> {
  const parsed = FleetSettingsSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  if (v["nudge.repeat_minutes"] === null)
    await deleteConfig(db, "nudge.repeat_minutes");
  else if (v["nudge.repeat_minutes"])
    await setConfig(
      db,
      "nudge.repeat_minutes",
      v["nudge.repeat_minutes"],
      EDITOR,
    );
  if (v["digest.sla_hours"] === null)
    await deleteConfig(db, "digest.sla_hours");
  else if (v["digest.sla_hours"])
    await setConfig(db, "digest.sla_hours", v["digest.sla_hours"], EDITOR);
  if (v["linear_sync.notify_customer"] !== undefined)
    await setConfig(
      db,
      "linear_sync.notify_customer",
      v["linear_sync.notify_customer"],
      EDITOR,
    );
  return getSettings(db, desk);
}
