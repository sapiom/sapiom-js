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
    sql: `-- Support desk M1 schema. Only _shared/issues.ts (and _shared/config.ts for \`config\`) write these tables.
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
    id: "060_watchdog",
    sql: `-- Watchdog: the failure poll's cursor (a single row) and the executions it has already reported.
-- The reported set is the dedup; the cursor only bounds how far back the next poll looks.

create table watchdog_state (
  id int primary key check (id = 1),
  cursor timestamptz not null
);

create table watchdog_reported (
  execution_id text primary key,
  agent text not null,
  reported_at timestamptz not null default now()
);
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
  {
    id: "063_watchdog_alerted",
    sql: `-- Watchdog: one row per distinct "cannot poll" problem it has told Slack about, so a persistent
-- failure (a revoked key) is announced once an hour rather than every tick.

create table watchdog_alerted (
  problem text primary key,
  alerted_at timestamptz not null default now()
);
`,
  },
  {
    id: "070_knowledge",
    sql: `-- Copilot knowledge: team-written articles, editable from the Console without a redeploy, and a
-- cache of pages fetched from the configured docs site. Only _shared/kb.ts writes kb_articles and only
-- _shared/docs.ts writes doc_cache. A policy is always in the draft prompt; an answer is a
-- team-written Q&A that the copilot includes or selects.

create table kb_articles (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('policy', 'answer')),
  title text not null,
  body text not null,
  enabled boolean not null default true,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table doc_cache (
  url text primary key,
  body text not null,
  fetched_at timestamptz not null default now()
);
`,
  },
  {
    id: "080_desks",
    sql: `-- Desks: one deployed fleet serves several isolated support desks. A desk owns its triage channel,
-- Linear target, on-call user and nudge timing; accounts and issues belong to one desk, and a
-- knowledge article belongs to one desk or (desk_id null) to every desk. Only _shared/desks.ts
-- writes \`desks\`.

create table desks (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  triage_channel text not null,
  linear_team_id text,
  linear_project_id text,
  oncall_slack_id text,
  nudge_minutes int not null default 30,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index desks_one_default on desks (is_default) where is_default;

alter table accounts add column desk_id uuid references desks (id);
alter table issues add column desk_id uuid references desks (id);
alter table kb_articles add column desk_id uuid references desks (id);

create index issues_desk_status on issues (desk_id, status);

-- A database that already ran the fleet holds one desk's worth of settings in \`config\`: make it the
-- default desk \`test\` and put every existing account and issue on it. A fresh database has no
-- \`channels.triage\` row, so no desk is inserted and setup creates them from fleet.json.
insert into desks (slug, name, triage_channel, linear_team_id, linear_project_id, oncall_slack_id, nudge_minutes, is_default)
select 'test', 'Test',
  replace(triage.value::text, '"', ''),
  replace(team.value::text, '"', ''),
  replace(project.value::text, '"', ''),
  replace(oncall.value::text, '"', ''),
  coalesce(nudge.value::text::int, 30),
  true
from config triage
left join config team on team.key = 'linear.team_id'
left join config project on project.key = 'linear.project_id'
left join config oncall on oncall.key = 'oncall.slack_id'
left join config nudge on nudge.key = 'nudge.minutes'
where triage.key = 'channels.triage';

update accounts set desk_id = (select id from desks where is_default);

update issues set desk_id = (select id from desks where is_default);
`,
  },
  {
    id: "081_desk_triage_unique",
    sql: `-- A triage channel belongs to one desk: button clicks and thread notes find their desk by channel,
-- so two desks sharing one would leave the second unreachable. Setup rejects duplicates before
-- writing; this index is the backstop. It fails on a database that already holds duplicates, which
-- must be given distinct channels first.

create unique index desks_triage_channel_unique on desks (triage_channel);
`,
  },
  {
    id: "082_issue_triage_channel",
    sql: `-- SAP-3722: preserve card addressing across desk channel changes.
-- Legacy cards have no recorded channel, so backfill assumes their desk still holds them.

alter table issues add column triage_channel text;

update issues set triage_channel = d.triage_channel
from desks d
where d.id = issues.desk_id and issues.triage_root_ts is not null;

update issues set triage_channel = d.triage_channel
from desks d
where d.is_default and issues.desk_id is null and issues.triage_root_ts is not null;
`,
  },
  {
    id: "090_digests",
    sql: `-- Daily digest: one row per desk and day it was posted, inserted in the same transaction as the
-- post, so a second fire on the same day posts nothing. Only _shared/issues.ts writes it.

create table digests (
  desk_id uuid not null references desks (id),
  day date not null,
  posted_at timestamptz not null default now(),
  primary key (desk_id, day)
);
`,
  },
  {
    id: "100_linear_state",
    sql: `-- linear-sync: the Linear workflow state it last read for an escalated issue ("In Progress", "Done"),
-- so the Console shows it without a Linear call. Null until the first check after this migration.

alter table issues add column linear_state text;
`,
  },
  {
    id: "101_draft_summary",
    sql: `-- The model's one-line summary, kept with the draft it was written for: a later run for an older
-- event rewrites issues.summary, and the newer draft's card and escalation must not show that one.

alter table drafts add column summary text;
`,
  },
  {
    id: "102_watchdog_event",
    sql: `-- Watchdog on \`sapiom.run.failed\`: it no longer polls, so the poll cursor and the "cannot poll"
-- alerts go. One row per failure posted, keyed on the run and when that failure finished, since a
-- resumed run that fails again is a new failure with the same execution id.

drop table if exists watchdog_state;
drop table if exists watchdog_alerted;
drop table if exists watchdog_reported;

create table watchdog_alerts (
  failure_key text primary key,
  execution_id text not null,
  agent text not null,
  posted_at timestamptz not null default now()
);
`,
  },
  {
    id: "110_ticket_timers",
    sql: `-- Per-ticket timers: the controller runs once when a ticket next needs something (a nudge, an
-- escalation level, a Linear check), from a one-shot schedule that _shared/timers.ts keeps here.
-- next_tick_id is that schedule's id, so the next change can cancel it; next_tick_at is when it
-- fires, so a change that lands on the same time leaves it alone. Both are null while nothing is due.

alter table issues add column next_tick_id text;
alter table issues add column next_tick_at timestamptz;
`,
  },
];
