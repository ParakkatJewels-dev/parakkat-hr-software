-- 0082 — The two Excel exports, by the same route everything else already takes.
--
-- 0052 moved sync and recompute onto a queue so the browser never has to reach the HR laptop, and
-- said so plainly: an HTTPS page cannot call http://192.168.1.45:8091, ever. The exports were left
-- on the direct HTTP route, so on the deployed site "Attendance register" and "Payroll export" do
-- nothing at all — the request is killed by the browser before it is sent. They work only for
-- someone sitting in the office with the app open over plain http.
--
-- WHY NOT JUST BUILD THE FILE IN THE BROWSER
-- It was the first thing I tried to justify. The service builds these with ExcelJS and colours
-- cells by attendance status — the colour IS the register, it is how you scan a 250 x 31 grid. The
-- frontend carries SheetJS, whose community build writes no styling at all. Porting would mean
-- either shipping a second spreadsheet library to every phone or handing back a grid of grey
-- numbers. The generator is 770 tested lines; it stays where it is and the FILE travels instead.
--
-- WHY A COLUMN AND NOT STORAGE
-- Uploading to Supabase Storage needs a service-role key on the HR laptop, which is a Windows
-- service somebody would have to reconfigure, and one more secret in one more place. The service
-- already holds a direct Postgres connection. A base64 column on the row that requested the file
-- needs no new credential, and the file is deleted by the same sweep that settles the row.
--
-- Base64 text rather than bytea because PostgREST renders bytea as hex, which is twice the size and
-- then has to be parsed in the browser; base64 goes straight into a Blob.

begin;

alter table public.service_commands
  drop constraint if exists service_commands_kind_values;

alter table public.service_commands
  add constraint service_commands_kind_values
  check (kind in (
    'sync_transactions', 'sync_employees', 'backfill', 'recompute', 'refresh_suggestions',
    'export_register', 'export_payroll'
  ));

alter table public.service_commands
  add column if not exists result_file     text,   -- base64 of the .xlsx
  add column if not exists result_filename text;

comment on column public.service_commands.result_file is
  'Base64 .xlsx for export commands. Cleared by expire_stale_service_commands once collected or aged out — these rows are a delivery mechanism, not an archive.';

/**
 * Queue a piece of work for the service.
 *
 * Recompute and the sync family are unchanged — 0071 settled those, and an unscoped recompute still
 * needs attendance.manage organisation-wide.
 *
 * The exports take report.read, or the permission for the specific sheet, held at BRANCH LEVEL OR
 * WIDER. That is not the usual any-scope check and it is not arbitrary: the service resolves an
 * export's rows through resolveVisibleScope(), which builds its branch list from global, entity,
 * zone and branch grants and deliberately ignores department and self ones, because these sheets
 * are whole-branch and a narrower grant would be silently widened to fill them. A department head
 * who passed an any-scope check here would get a file back with more people in it than they may
 * see. So the gate matches the resolver rather than being a looser thing next to it.
 */
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
    if not app.has_perm_org_wide('attendance.manage') then
      raise exception 'You do not have permission to recompute attendance.' using errcode = '42501';
    end if;

  elsif not app.has_perm_org_wide('device.manage') then
    raise exception 'You do not have permission to run sync operations.' using errcode = '42501';
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

/**
 * Held at a scope that spans whole branches.
 *
 * The mirror of resolveVisibleScope() in the attendance service: global, entity, zone and branch
 * count; department and self contribute nothing. has_perm_org_wide is too strict for this (it stops
 * at entity, so no branch manager would ever pass) and has_perm_any_scope is too loose (a self
 * grant would).
 */
create or replace function app.has_perm_at_branch_or_wider(_perm text)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid()
           and p.key = _perm
           and ra.scope_type in ('global', 'entity', 'zone', 'branch')
      );
$$;

grant execute on function app.has_perm_at_branch_or_wider(text) to authenticated;

/**
 * Settle abandoned commands, and stop finished exports from becoming an archive.
 *
 * Unchanged except for the last statement. A generated register is a few hundred kilobytes of
 * base64 sitting on a row; the browser collects it within seconds of the command finishing, and
 * after that it is dead weight in every backup forever. An hour is long enough for a tab that was
 * left in the background, and short enough that the table does not grow without bound.
 *
 * The row itself stays — the history of who exported what is worth keeping. Only the payload goes.
 */
create or replace function public.expire_stale_service_commands()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  _n integer;
begin
  update public.service_commands
     set status = 'failed',
         finished_at = now(),
         error_message = case
           when status = 'pending'
             then 'nothing collected this within 5 minutes — the sync service is not running, or is running a build without the command worker'
           else 'still running after 2 hours — the service stopped before it finished'
         end
   where (status = 'pending' and requested_at < now() - interval '5 minutes')
      or (status = 'running' and claimed_at  < now() - interval '2 hours');

  get diagnostics _n = row_count;

  update public.service_commands
     set result_file = null
   where result_file is not null
     and finished_at < now() - interval '1 hour';

  return _n;
end $$;

-- Whoever asked for a file has to be able to collect it.
--
-- Reading was device.manage organisation-wide, which is the sync screen's audience and nobody else.
-- A branch manager can now queue an export, and would have had no way to read the row their own
-- file arrives on.
drop policy if exists service_commands_select on public.service_commands;
create policy service_commands_select on public.service_commands
  for select
  using (app.has_perm_org_wide('device.manage') or requested_by = auth.uid());

commit;
