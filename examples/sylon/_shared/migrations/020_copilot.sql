-- E4 copilot: the event that produced a draft (so a retried or redelivered event reuses it) and the
-- model's confidence. citations stays a list of kb page slugs.

alter table drafts add column causation_id text;
alter table drafts add column confidence real;
create index drafts_issue_causation on drafts (issue_id, causation_id);
