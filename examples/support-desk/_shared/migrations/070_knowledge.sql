-- Copilot knowledge: team-written articles, editable from the Console without a redeploy, and a
-- cache of pages fetched from docs.sapiom.ai. Only _shared/kb.ts writes kb_articles and only
-- _shared/docs.ts writes doc_cache. A policy is always in the draft prompt; an answer is a
-- team-written Q&A that the copilot includes or selects.

create table kb_articles (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('policy', 'answer')),
  title text not null,
  body text not null,
  enabled boolean not null default true,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table doc_cache (
  url text primary key,
  body text not null,
  fetched_at timestamptz not null default now()
);
