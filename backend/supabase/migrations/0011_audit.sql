-- 0011_audit.sql
-- Audit trail: a generic trigger records writes to key tables into audit_log. Scoped for viewing
-- via a new audit.read permission (entity admins see their entity; super admin sees all).

insert into public.permissions (key, resource, action, description) values
  ('audit.read', 'audit', 'read', 'View the audit trail')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r join public.permissions p on p.key = 'audit.read'
where r.key in ('super_admin', 'entity_admin')
on conflict do nothing;

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor       uuid,                 -- auth.uid() of who did it (null for system/service)
  actor_email text,
  action      text not null,        -- INSERT / UPDATE / DELETE
  table_name  text not null,
  row_id      uuid,
  entity_id   uuid,                 -- scope of the affected row (for RLS viewing)
  branch_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_log(created_at desc);

-- Generic audit trigger. Attached tables must expose an `id` (and, ideally, entity_id/branch_id).
create or replace function app.tg_audit()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  rec        jsonb := to_jsonb(coalesce(new, old));
  _entity    uuid := nullif(rec->>'entity_id','')::uuid;
  _branch    uuid := nullif(rec->>'branch_id','')::uuid;
  _email     text;
begin
  select email into _email from auth.users where id = auth.uid();
  insert into public.audit_log (actor, actor_email, action, table_name, row_id, entity_id, branch_id)
  values (auth.uid(), _email, tg_op, tg_table_name, nullif(rec->>'id','')::uuid, _entity, _branch);
  return coalesce(new, old);
end $$;

-- Attach to the most security-relevant tables.
drop trigger if exists trg_audit on public.employees;
create trigger trg_audit after insert or update or delete on public.employees for each row execute function app.tg_audit();
drop trigger if exists trg_audit on public.role_assignments;
create trigger trg_audit after insert or update or delete on public.role_assignments for each row execute function app.tg_audit();
drop trigger if exists trg_audit on public.leaves;
create trigger trg_audit after insert or update or delete on public.leaves for each row execute function app.tg_audit();
drop trigger if exists trg_audit on public.expenses;
create trigger trg_audit after insert or update or delete on public.expenses for each row execute function app.tg_audit();

-- RLS: super admin or an audit.read holder over the row's scope may read; nobody writes directly.
alter table public.audit_log enable row level security;
create policy audit_select on public.audit_log for select to authenticated
  using (app.has_perm('audit.read', entity_id, null, branch_id, null, null));

grant select on public.audit_log to authenticated;
