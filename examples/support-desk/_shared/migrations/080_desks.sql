-- Desks: one deployed fleet serves several isolated support desks. A desk owns its triage channel,
-- Linear target, on-call user and nudge timing; accounts and issues belong to one desk, and a
-- knowledge article belongs to one desk or (desk_id null) to every desk. Only _shared/desks.ts
-- writes `desks`.

create table desks (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  triage_channel text not null,
  linear_team_id text,
  linear_project_id text,
  oncall_slack_id text,
  nudge_minutes int not null default 30,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index desks_one_default on desks (is_default) where is_default;

alter table accounts add column desk_id uuid references desks (id);
alter table issues add column desk_id uuid references desks (id);
alter table kb_articles add column desk_id uuid references desks (id);

create index issues_desk_status on issues (desk_id, status);

-- A database that already ran the fleet holds one desk's worth of settings in `config`: make it the
-- default desk `test` and put every existing account and issue on it. A fresh database has no
-- `channels.triage` row, so no desk is inserted and setup creates them from fleet.json.
insert into desks (slug, name, triage_channel, linear_team_id, linear_project_id, oncall_slack_id, nudge_minutes, is_default)
select 'test', 'Test',
  replace(triage.value::text, '"', ''),
  replace(team.value::text, '"', ''),
  replace(project.value::text, '"', ''),
  replace(oncall.value::text, '"', ''),
  coalesce(nudge.value::text::int, 30),
  true
from config triage
left join config team on team.key = 'linear.team_id'
left join config project on project.key = 'linear.project_id'
left join config oncall on oncall.key = 'oncall.slack_id'
left join config nudge on nudge.key = 'nudge.minutes'
where triage.key = 'channels.triage';

update accounts set desk_id = (select id from desks where is_default);

update issues set desk_id = (select id from desks where is_default);
