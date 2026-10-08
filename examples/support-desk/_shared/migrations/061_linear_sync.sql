-- linear-sync: when it last read the issue's Linear state, so a backlog larger than one tick's read
-- cap rotates oldest-checked first. Null until the first check.

alter table issues add column linear_checked_at timestamptz;
create index issues_linear_checked on issues (status, linear_checked_at);
