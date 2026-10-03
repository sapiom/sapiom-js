/**
 * The only reader and writer of `kb_articles`: the team's own knowledge, edited in the Console and
 * read by the copilot on every draft. Public docs are not stored here; see `docs.ts`.
 *
 * `policy` articles are rules the copilot always follows (refunds, SLAs, tone). `answer` articles
 * are team-written Q&A it may quote. An article belongs to one desk, or to every desk when its
 * `deskId` is null.
 */
import type { Db, Row } from "./db";

export type KbKind = "policy" | "answer";
export const KB_KINDS: readonly KbKind[] = ["policy", "answer"];

export interface KbArticle {
  id: string;
  kind: KbKind;
  title: string;
  body: string;
  enabled: boolean;
  /** Null: applies to every desk. */
  deskId: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KbInput {
  kind: KbKind;
  title: string;
  body: string;
  enabled?: boolean;
  deskId?: string | null;
}

/** Patchable fields and their columns; the column names are interpolated into SQL, so only these pass. */
const PATCHABLE: Record<string, string> = {
  kind: "kind",
  title: "title",
  body: "body",
  enabled: "enabled",
  deskId: "desk_id",
};

const COLUMNS =
  "id, kind, title, body, enabled, desk_id, updated_by, created_at, updated_at";

function toArticle(r: Row): KbArticle {
  return {
    id: r.id as string,
    kind: r.kind as KbKind,
    title: r.title as string,
    body: r.body as string,
    enabled: r.enabled as boolean,
    deskId: (r.desk_id as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

/**
 * Articles, policies first, then by title: the Console list. With `deskId`, that desk's articles
 * and the all-desks ones; without it, every article.
 */
export async function listArticles(
  db: Db,
  opts: { deskId?: string } = {},
): Promise<KbArticle[]> {
  const rows = opts.deskId
    ? await db.query(
        `select ${COLUMNS} from kb_articles where desk_id is null or desk_id = $1 order by kind desc, lower(title), created_at`,
        [opts.deskId],
      )
    : await db.query(
        `select ${COLUMNS} from kb_articles order by kind desc, lower(title), created_at`,
      );
  return rows.map(toArticle);
}

/**
 * What the copilot reads for an issue on `deskId`: enabled articles that apply to that desk or to
 * every desk, in a stable order. An issue without a desk sees only the all-desks articles.
 */
export async function listEnabled(
  db: Db,
  deskId: string | null,
): Promise<KbArticle[]> {
  const rows = deskId
    ? await db.query(
        `select ${COLUMNS} from kb_articles where enabled and (desk_id is null or desk_id = $1) order by kind desc, lower(title), created_at`,
        [deskId],
      )
    : await db.query(
        `select ${COLUMNS} from kb_articles where enabled and desk_id is null order by kind desc, lower(title), created_at`,
      );
  return rows.map(toArticle);
}

export async function getArticle(
  db: Db,
  id: string,
): Promise<KbArticle | null> {
  const rows = await db.query(
    `select ${COLUMNS} from kb_articles where id = $1`,
    [id],
  );
  return rows[0] ? toArticle(rows[0]) : null;
}

export async function createArticle(
  db: Db,
  input: KbInput,
  updatedBy: string,
): Promise<KbArticle> {
  const rows = await db.query(
    `insert into kb_articles (kind, title, body, enabled, desk_id, updated_by)
     values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
    [
      input.kind,
      input.title,
      input.body,
      input.enabled ?? true,
      input.deskId ?? null,
      updatedBy,
    ],
  );
  return toArticle(rows[0]);
}

/** Apply the given fields; null when the article does not exist. */
export async function updateArticle(
  db: Db,
  id: string,
  patch: Partial<KbInput>,
  updatedBy: string,
): Promise<KbArticle | null> {
  // Only the patched columns are written, so a concurrent edit to another field is not reverted
  // by a stale full-row copy.
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, value] of Object.entries(definedOnly(patch))) {
    const column = PATCHABLE[key];
    if (!column) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  params.push(updatedBy);
  sets.push(`updated_by = $${params.length}`, "updated_at = now()");
  const rows = await db.query(
    `update kb_articles set ${sets.join(", ")} where id = $1 returning ${COLUMNS}`,
    params,
  );
  return rows[0] ? toArticle(rows[0]) : null;
}

/** True when a row was deleted. */
export async function deleteArticle(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(
    "delete from kb_articles where id = $1 returning id",
    [id],
  );
  return rows.length > 0;
}

export async function countArticles(db: Db): Promise<number> {
  const rows = await db.query<{ n: string | number }>(
    "select count(*) as n from kb_articles",
  );
  return Number(rows[0].n);
}

/** Titles by id, for labelling citations; ids that no longer exist are absent. */
export async function articleTitles(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const id of ids) {
    if (!UUID.test(id)) continue;
    const a = await getArticle(db, id);
    if (a) found.set(id, a.title);
  }
  return found;
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Starter policies written by `pnpm run setup` into an empty table. They are examples to edit or
 * delete in the Console, not product facts.
 */
export const STARTER_POLICIES: readonly KbInput[] = [
  {
    kind: "policy",
    title: "Billing questions beyond the pricing page",
    body: "For anything about invoices, refunds, credits or contract terms that the public pricing page does not answer, do not quote an amount or promise an outcome. Say a teammate will confirm and ask for the account or invoice identifier.",
  },
  {
    kind: "policy",
    title: "Never ask for credentials",
    body: "Never ask a customer to send passwords, API keys, tokens, signing secrets or other credentials. If they paste one, tell them to rotate it and do not repeat it.",
  },
  {
    kind: "policy",
    title: "Tone",
    body: "Plain and direct. Acknowledge the problem in one sentence, then give the next step. No apologies beyond one, no marketing language.",
  },
];

/** Insert the starters only when the table is empty; returns how many were added. */
export async function seedStarters(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    if ((await countArticles(tx)) > 0) return 0;
    for (const p of STARTER_POLICIES) await createArticle(tx, p, "setup");
    return STARTER_POLICIES.length;
  });
}
