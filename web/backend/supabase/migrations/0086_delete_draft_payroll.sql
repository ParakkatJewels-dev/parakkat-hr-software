-- Draft payroll is disposable working data. Published payroll is permanent.
--
-- The trigger is the final guard: it protects every delete path, including direct REST calls.
-- The RPC gives the web app one atomic, permission-checked operation. Existing foreign keys remove
-- the draft payslips and their line items when the run is deleted.

begin;

create or replace function app.tg_guard_payroll_run_delete()
returns trigger
language plpgsql
set search_path = app, public
as $$
begin
  if old.status <> 'Draft' then
    raise exception 'Only draft payroll runs can be deleted.'
      using errcode = '23514';
  end if;
  return old;
end
$$;

drop trigger if exists trg_guard_payroll_run_delete on public.payroll_runs;
create trigger trg_guard_payroll_run_delete
  before delete on public.payroll_runs
  for each row execute function app.tg_guard_payroll_run_delete();

create or replace function public.delete_draft_payroll(_run_id uuid)
returns void
language plpgsql
security definer
set search_path = app, public
as $$
declare
  _run public.payroll_runs%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required.'
      using errcode = '28000';
  end if;

  select *
    into _run
    from public.payroll_runs
   where id = _run_id
   for update;

  if not found then
    raise exception 'Payroll run not found.'
      using errcode = 'P0002';
  end if;

  if not app.has_perm('payroll.manage', _run.entity_id, null, null, null, null) then
    raise exception 'You are not authorized to delete payroll for this company.'
      using errcode = '42501';
  end if;

  if _run.status <> 'Draft' then
    raise exception 'Only draft payroll runs can be deleted.'
      using errcode = '23514';
  end if;

  delete from public.payroll_runs where id = _run_id;
end
$$;

revoke execute on function public.delete_draft_payroll(uuid) from public, anon;
grant execute on function public.delete_draft_payroll(uuid) to authenticated;

comment on function public.delete_draft_payroll(uuid) is
  'Deletes one authorized Draft payroll run. Published runs are rejected; draft payslips cascade.';

commit;
