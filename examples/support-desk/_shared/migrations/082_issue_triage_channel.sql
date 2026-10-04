-- SAP-3722: preserve card addressing across desk channel changes.
-- Legacy cards have no recorded channel, so backfill assumes their desk still holds them.

alter table issues add column triage_channel text;

update issues set triage_channel = d.triage_channel
from desks d
where d.id = issues.desk_id and issues.triage_root_ts is not null;

update issues set triage_channel = d.triage_channel
from desks d
where d.is_default and issues.desk_id is null and issues.triage_root_ts is not null;
