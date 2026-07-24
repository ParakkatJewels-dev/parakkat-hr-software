-- 0001_init.sql
-- Foundation: private `app` schema for security-definer helpers, and the scope enum.
-- Run order: 0001 -> 0002 -> ... -> 0008.

create schema if not exists app;

-- The six levels a role can be granted at. Scope cascades downward:
-- entity ⊇ its zones ⊇ their branches ⊇ their departments. 'self' = the caller's own employee row.
do $$ begin
  create type public.scope_type as enum ('global','entity','zone','branch','department','self');
exception when duplicate_object then null; end $$;

-- Shared trigger to maintain updated_at timestamps.
create or replace function app.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
