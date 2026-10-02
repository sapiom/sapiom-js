/**
 * The fixture world for a local trace. `run_local` gives every execution a fresh database seeded
 * from fleet.json only, so the issue and drafts the fixtures name (`fixtures/issue/*.json`,
 * `fixtures/slack/block-actions.draft-*.json`, `fixtures/copilot/*.json`) would not exist and every
 * fixture would exit at "issue not found". This inserts them, once, on an in-memory database.
 *
 * Raw SQL on purpose: `issues.ts` generates ids, and the fixtures need fixed ones. Never runs
 * against Postgres.
 */
import type { Db } from "../../_shared/db";
import { accountByChannel } from "../../_shared/issues";

export const FIXTURE_ISSUE = "a1b2c3d4-0000-4000-8000-0000000000a1";
/** The customer message that opened the issue. `issue/message-added.json` names a later one (b1), not stored. */
export const FIXTURE_MESSAGE = "a1b2c3d4-0000-4000-8000-0000000000b0";
/** Pending; the target of the three `draft.*` click fixtures. */
export const FIXTURE_DRAFT = "a1b2c3d4-0000-4000-8000-0000000000d1";
/** Already approved; the target of `fixtures/copilot/block-actions.draft-approve.decided.json`. */
export const FIXTURE_DECIDED_DRAFT = "a1b2c3d4-0000-4000-8000-0000000000d2";

const CUSTOMER_CHANNEL = "C0CUSTOMER1";
const TRIAGE_CHANNEL = "C0TRIAGE001";
const CUSTOMER_ROOT_TS = "1790889355.981329";
const TRIAGE_ROOT_TS = "1790889400.000200";

export async function seedLocalFixtures(db: Db): Promise<void> {
  if (db.kind !== "memory") return;
  const seen = await db.query("select 1 from issues where id = $1", [
    FIXTURE_ISSUE,
  ]);
  if (seen.length > 0) return;
  const account = await accountByChannel(db, CUSTOMER_CHANNEL);
  if (!account) return;
  await db.query(
    `insert into issues (id, account_id, source, status, category, priority, title, customer_channel, customer_root_ts, triage_root_ts)
     values ($1, $2, 'slack', 'new', 'question', 'normal', 'Webhook deliveries failing', $3, $4, $5)`,
    [
      FIXTURE_ISSUE,
      account.id,
      CUSTOMER_CHANNEL,
      CUSTOMER_ROOT_TS,
      TRIAGE_ROOT_TS,
    ],
  );
  await db.query(
    `insert into messages (id, issue_id, source, source_event_id, channel, ts, user_id, direction, text)
     values ($1, $2, 'slack', 'Ev0EXAMPLE01', $3, $4, 'U0CUSTOMER1', 'customer', $5)`,
    [
      FIXTURE_MESSAGE,
      FIXTURE_ISSUE,
      CUSTOMER_CHANNEL,
      CUSTOMER_ROOT_TS,
      "Our webhook deliveries started failing this morning with signature errors. Did something change?",
    ],
  );
  await db.query(
    `insert into drafts (id, issue_id, card_channel, card_ts, text, citations, causation_id, confidence, status)
     values ($1, $2, $3, '1790889450.000250', $4, $5::text::jsonb, 'Ev0FIXTURE00', 0.7, 'pending')`,
    [
      FIXTURE_DRAFT,
      FIXTURE_ISSUE,
      TRIAGE_CHANNEL,
      "Nothing changed on our side. Signature errors usually mean the body was re-serialized before verification; verify against the raw bytes.",
      JSON.stringify(["webhooks"]),
    ],
  );
  await db.query(
    `insert into drafts (id, issue_id, card_channel, card_ts, text, citations, causation_id, confidence, status, decided_by, decided_at)
     values ($1, $2, $3, '1790889460.000260', $4, $5::text::jsonb, 'Ev0FIXTURE01', 0.6, 'approved', 'U0TEAMMATE2', now())`,
    [
      FIXTURE_DECIDED_DRAFT,
      FIXTURE_ISSUE,
      TRIAGE_CHANNEL,
      "An earlier reply that a teammate already approved.",
      JSON.stringify([]),
    ],
  );
  // Its reply went out, so the card reads "Approved and sent".
  await db.query(
    `insert into messages (issue_id, source, source_event_id, channel, ts, thread_ts, user_id, direction, text)
     values ($1, 'slack', $2, $3, '1790889470.000270', $4, 'U0TEAMMATE2', 'agent', $5)`,
    [
      FIXTURE_ISSUE,
      `draft:${FIXTURE_DECIDED_DRAFT}`,
      CUSTOMER_CHANNEL,
      CUSTOMER_ROOT_TS,
      "An earlier reply that a teammate already approved.",
    ],
  );
}
