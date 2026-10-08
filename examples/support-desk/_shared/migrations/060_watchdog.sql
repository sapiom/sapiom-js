-- Watchdog: the failure poll's cursor (a single row) and the executions it has already reported.
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
