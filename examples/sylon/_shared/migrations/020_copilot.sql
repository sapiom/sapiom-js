-- E4 copilot: the event that produced a draft and the model's confidence. citations stays a list
-- of kb page slugs. The unique index makes one draft per triggering event, so concurrent
-- deliveries of the same event share one row; Postgres treats NULLs as distinct, so drafts
-- without a causation stay allowed.

alter table drafts add column causation_id text;
alter table drafts add column confidence real;
create unique index drafts_issue_causation on drafts (issue_id, causation_id);
