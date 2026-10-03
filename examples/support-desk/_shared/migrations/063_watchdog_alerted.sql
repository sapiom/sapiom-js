-- Watchdog: one row per distinct "cannot poll" problem it has told Slack about, so a persistent
-- failure (a revoked key) is announced once an hour rather than every tick.

create table watchdog_alerted (
  problem text primary key,
  alerted_at timestamptz not null default now()
);
