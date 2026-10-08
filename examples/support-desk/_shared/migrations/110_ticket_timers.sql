-- Per-ticket timers: the controller runs once when a ticket next needs something (a nudge, an
-- escalation level, a Linear check), from a one-shot schedule that _shared/timers.ts keeps here.
-- next_tick_id is that schedule's id, so the next change can cancel it; next_tick_at is when it
-- fires, so a change that lands on the same time leaves it alone. Both are null while nothing is due.

alter table issues add column next_tick_id text;
alter table issues add column next_tick_at timestamptz;
