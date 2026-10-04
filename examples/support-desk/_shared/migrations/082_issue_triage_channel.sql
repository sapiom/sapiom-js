-- An issue's triage card stays in the channel it was posted in, even after its desk's triage
-- channel moves (SAP-3722). Existing cards are assumed to sit in their desk's current channel, the
-- same desk deskForIssue picks (default desk when desk_id is null). update ... from, not a
-- correlated subquery: pg-mem runs the former.

alter table issues add column triage_channel text;

update issues set triage_channel = d.triage_channel
from desks d
where d.id = issues.desk_id and issues.triage_root_ts is not null;

update issues set triage_channel = d.triage_channel
from desks d
where d.is_default and issues.desk_id is null and issues.triage_root_ts is not null;
