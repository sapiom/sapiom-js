/**
 * Migrations as source strings. The agent bundler inlines TypeScript but has no `.sql` loader, so
 * each `.sql` file beside this one is mirrored here; `migrations.test.ts` fails if they drift.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_init",
    sql: `-- Sylon M1 schema. Only _shared/issues.ts (and _shared/config.ts for \`config\`) write these tables.
-- Applied once per database by _shared/db.ts \`migrate\`, tracked in schema_migrations.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slack_channel_id text not null unique,
  created_at timestamptz not null default now()
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  number serial unique,
  account_id uuid not null references accounts (id),
  source text not null,
  status text not null default 'new',
  category text,
  priority text,
  title text,
  summary text,
  customer_channel text,
  customer_root_ts text,
  triage_root_ts text,
  owner_slack_id text,
  linear_issue_id text,
  linear_identifier text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index issues_account_status on issues (account_id, status);
create index issues_customer_thread on issues (customer_channel, customer_root_ts);
create index issues_triage_root on issues (triage_root_ts);

create table messages (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid references issues (id),
  source text not null,
  source_event_id text not null unique,
  channel text,
  ts text,
  thread_ts text,
  user_id text,
  user_name text,
  direction text not null,
  text text,
  jev jsonb,
  created_at timestamptz not null default now()
);

create index messages_issue on messages (issue_id, created_at);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id),
  card_channel text,
  card_ts text,
  text text not null,
  citations jsonb,
  status text not null default 'pending',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index drafts_issue_status on drafts (issue_id, status);

create table nudges (
  issue_id uuid not null references issues (id),
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (issue_id, kind)
);

create table runs (
  execution_id text primary key,
  issue_id uuid,
  agent text not null,
  started_at timestamptz not null default now()
);

create table events_log (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  emitted_by text,
  receipt_id text,
  created_at timestamptz not null default now()
);

create table config (
  key text primary key,
  value jsonb not null,
  set_by text,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    id: "020_copilot",
    sql: `-- E4 copilot: the event that produced a draft and the model's confidence. citations stays a list
-- of kb page slugs. The unique index makes one draft per triggering event, so concurrent
-- deliveries of the same event share one row; Postgres treats NULLs as distinct, so drafts
-- without a causation stay allowed.

alter table drafts add column causation_id text;
alter table drafts add column confidence real;
create unique index drafts_issue_causation on drafts (issue_id, causation_id);
`,
  },
  {
    id: "050_linear_url",
    sql: `-- E7: the Linear issue's URL beside its identifier, so the triage card can link to it. Null for
-- issues escalated before this column existed; the card then shows the bare identifier.

alter table issues add column linear_url text;
`,
  },
  {
    id: "061_linear_sync",
    sql: `-- linear-sync: when it last read the issue's Linear state, so a backlog larger than one tick's read
-- cap rotates oldest-checked first. Null until the first check.

alter table issues add column linear_checked_at timestamptz;
create index issues_linear_checked on issues (status, linear_checked_at);
`,
  },
  {
    id: "062_escalation_generation",
    sql: `-- linear-sync: on_hold_at is when the issue last entered On Hold (one value per escalation), so a
-- repeat escalation gets its own dedup keys. card_dirty marks a triage card that still has to be
-- redrawn after a status move, so a failed Slack update is retried on a later tick.

alter table issues add column on_hold_at timestamptz;
alter table issues add column card_dirty boolean not null default false;
update issues set on_hold_at = updated_at where status = 'on_hold';
create index issues_card_dirty on issues (card_dirty) where card_dirty;
`,
  },
];
