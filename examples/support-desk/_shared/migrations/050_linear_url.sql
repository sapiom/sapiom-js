-- E7: the Linear issue's URL beside its identifier, so the triage card can link to it. Null for
-- issues escalated before this column existed; the card then shows the bare identifier.

alter table issues add column linear_url text;
