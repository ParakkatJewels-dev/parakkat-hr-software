-- Operational service commands use one shared BioTime integration and cannot be narrowed to an
-- entity. Match the worker's current-authority check when enqueueing, so an entity-scoped device
-- manager gets a permission refusal immediately rather than a command guaranteed to fail later.
-- Branch-scoped exports, global recompute authority, duplicate guards and RPC grants are unchanged.
create or replace function public.request_service_command(
  _kind   text,
  _params jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  _id      uuid;
  _pending integer;
begin
  if _kind in ('export_register', 'export_payroll') then
    if not (
      app.has_perm_at_branch_or_wider('report.read')
      or app.has_perm_at_branch_or_wider(
           case when _kind = 'export_register' then 'attendance.read' else 'payslip.read' end)
    ) then
      raise exception
        'Exports cover whole branches, so they need attendance or reporting access over a branch, zone or company — not just your own record.'
        using errcode = '42501';
    end if;

  elsif _kind = 'recompute' then
    -- An unscoped rebuild has always required global attendance authority.
    if not app.has_perm_globally('attendance.manage') then
      raise exception 'A full recompute rebuilds every company''s attendance and requires global attendance.manage access.'
        using errcode = '42501';
    end if;

  elsif not app.has_perm_globally('device.manage') then
    raise exception 'Sync, roster and backfill operations affect every company and require global device.manage access.' using errcode = '42501';
  end if;

  -- Sync and backfill hammer the one on-prem BioTime box, so only one may be in flight at a time
  -- for the whole company. An export reads Postgres and writes a file for one person; two people
  -- exporting two different months is ordinary, and a shared guard would have the second of them
  -- told to wait for work that has nothing to do with them.
  if _kind in ('export_register', 'export_payroll') then
    select count(*) into _pending from public.service_commands
     where kind = _kind and status in ('pending', 'running') and requested_by = auth.uid();
  else
    select count(*) into _pending from public.service_commands
     where kind = _kind and status in ('pending', 'running');
  end if;

  if _pending > 0 then
    raise exception 'A % is already queued or running.', replace(_kind, '_', ' ')
      using errcode = '55006';
  end if;

  insert into public.service_commands (kind, params, requested_by)
  values (_kind, coalesce(_params, '{}'::jsonb), auth.uid())
  returning id into _id;

  return _id;
end $$;
