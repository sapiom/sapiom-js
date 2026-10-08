-- linear-sync: on_hold_at is when the issue last entered On Hold (one value per escalation), so a
-- repeat escalation gets its own dedup keys. card_dirty marks a triage card that still has to be
-- redrawn after a status move, so a failed Slack update is retried on a later tick.

alter table issues add column on_hold_at timestamptz;
alter table issues add column card_dirty boolean not null default false;
update issues set on_hold_at = updated_at where status = 'on_hold';
create index issues_card_dirty on issues (card_dirty) where card_dirty;
