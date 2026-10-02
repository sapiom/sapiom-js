/**
 * The only reader and writer of `kb_articles`: the team's own knowledge, edited in the Console and
 * read by the copilot on every draft. Public docs are not stored here; see `docs.ts`.
 *
 * `policy` articles are rules the copilot always follows (refunds, SLAs, tone). `answer` articles
 * are team-written Q&A it may quote.
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
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KbInput {
  kind: KbKind;
  title: string;
  body: string;
  enabled?: boolean;
}

const COLUMNS =
  "id, kind, title, body, enabled, updated_by, created_at, updated_at";

function toArticle(r: Row): KbArticle {
  return {
    id: r.id as string,
    kind: r.kind as KbKind,
    title: r.title as string,
    body: r.body as string,
    enabled: r.enabled as boolean,
    updatedBy: (r.updated_by as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

/** Every article, policies first, then by title: the Console list. */
export async function listArticles(db: Db): Promise<KbArticle[]> {
  const rows = await db.query(
    `select ${COLUMNS} from kb_articles order by kind desc, lower(title), created_at`,
  );
  return rows.map(toArticle);
}

/** What the copilot reads: enabled articles only, in a stable order. */
export async function listEnabled(db: Db): Promise<KbArticle[]> {
  const rows = await db.query(
    `select ${COLUMNS} from kb_articles where enabled order by kind desc, lower(title), created_at`,
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
    `insert into kb_articles (kind, title, body, enabled, updated_by)
     values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [input.kind, input.title, input.body, input.enabled ?? true, updatedBy],
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
  const current = await getArticle(db, id);
  if (!current) return null;
  const next = { ...current, ...definedOnly(patch) };
  const rows = await db.query(
    `update kb_articles
        set kind = $2, title = $3, body = $4, enabled = $5, updated_by = $6, updated_at = now()
      where id = $1 returning ${COLUMNS}`,
    [id, next.kind, next.title, next.body, next.enabled, updatedBy],
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
