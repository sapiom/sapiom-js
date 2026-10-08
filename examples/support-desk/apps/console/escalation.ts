/** Injecting Db lets specs exercise real SQL on pg-mem without starting the Console server. */
import {
  DeskEscalationSchema,
  deskEscalation,
  setDeskEscalation,
} from "../../_shared/config";
import type { Db } from "../../_shared/db";
import { oncallFor, type Desk } from "../../_shared/desks";

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
