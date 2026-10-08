-- Daily digest: one row per desk and day it was posted, inserted in the same transaction as the
-- post, so a second fire on the same day posts nothing. Only _shared/issues.ts writes it.

create table digests (
  desk_id uuid not null references desks (id),
  day date not null,
  posted_at timestamptz not null default now(),
  primary key (desk_id, day)
);
