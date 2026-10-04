-- The model's one-line summary, kept with the draft it was written for: a later run for an older
-- event rewrites issues.summary, and the newer draft's card and escalation must not show that one.

alter table drafts add column summary text;
