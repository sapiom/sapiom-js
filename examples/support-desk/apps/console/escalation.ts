/**
 * The Console's escalation card: read and write one desk's `escalation` config entry. Pure over a
 * `Db` and returning `{ status, body }`, so a spec runs it on pg-mem; `server.ts` maps the status.
 */
import {
  DeskEscalationSchema,
  deskEscalation,
  setDeskEscalation,
} from "../../_shared/config";
import type { Db } from "../../_shared/db";
import { oncallFor, type Desk } from "../../_shared/desks";

/** Recorded as `config.set_by`. */
const EDITOR = "console";

export async function getEscalation(db: Db, desk: Desk) {
  return {
    status: 200,
    body: {
      desk: desk.slug,
      entry: await deskEscalation(db, desk.slug),
      oncallFallback: await oncallFor(db, desk),
    },
  };
}

/** `{ off: true }` removes the desk's entry; anything else must be a valid entry. */
export async function putEscalation(
  db: Db,
  desk: Desk,
  body: Record<string, unknown>,
) {
  let entry = null;
  if (body.off !== true) {
    const parsed = DeskEscalationSchema.safeParse(body);
    if (!parsed.success)
      return {
        status: 400,
        body: {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "entry"}: ${i.message}`)
            .join("; "),
        },
      };
    entry = parsed.data;
  }
  await setDeskEscalation(db, desk.slug, entry, EDITOR);
  return getEscalation(db, desk);
}
