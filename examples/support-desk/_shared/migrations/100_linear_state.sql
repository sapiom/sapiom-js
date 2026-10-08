-- linear-sync: the Linear workflow state it last read for an escalated issue ("In Progress", "Done"),
-- so the Console shows it without a Linear call. Null until the first check after this migration.

alter table issues add column linear_state text;
