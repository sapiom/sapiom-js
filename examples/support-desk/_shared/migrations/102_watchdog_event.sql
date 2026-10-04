-- Watchdog on `sapiom.run.failed`: it no longer polls, so the poll cursor and the "cannot poll"
-- alerts go. One row per failure posted, keyed on the run and when that failure finished, since a
-- resumed run that fails again is a new failure with the same execution id.

drop table watchdog_state;
drop table watchdog_alerted;
drop table watchdog_reported;

create table watchdog_alerts (
  failure_key text primary key,
  execution_id text not null,
  agent text not null,
  posted_at timestamptz not null default now()
);
