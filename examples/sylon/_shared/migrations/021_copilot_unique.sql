-- E4 copilot: one draft per triggering event, so concurrent deliveries of the same event cannot
-- each post a card. Postgres treats NULLs as distinct, so drafts without a causation stay allowed.

drop index drafts_issue_causation;
create unique index drafts_issue_causation on drafts (issue_id, causation_id);
