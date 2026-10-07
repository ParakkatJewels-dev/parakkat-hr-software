-- Itemized monthly adjustments, issued advances and payment tracking.
-- Publication recognizes scheduled advance recovery against earned salary; draft schedules reserve
-- the balance. Recording a payment never initiates a bank transaction or changes a payslip.
begin;

create table if not exists public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id),
  employee_id uuid not null references public.employees(id),
  zone_id uuid, branch_id uuid, department_id uuid,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind text not null check (kind in ('bonus','incentive','deduction')),
  amount numeric(10,2) not null check (amount>0 and amount<100000000),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists payroll_adjustments_month_idx on public.payroll_adjustments(entity_id,period,employee_id);
create table if not exists public.payroll_advances (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  entity_id uuid not null references public.entities(id),
  employee_id uuid not null references public.employees(id),
  zone_id uuid, branch_id uuid, department_id uuid,
  issued_on date not null check (isfinite(issued_on)),
  amount numeric(10,2) not null check (amount>0 and amount<100000000),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  voided_at timestamptz, void_reason text,
  check ((voided_at is null and void_reason is null) or (voided_at is not null and void_reason is not null and length(btrim(void_reason)) between 1 and 500)),
  created_by uuid, created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists payroll_advances_employee_idx on public.payroll_advances(entity_id,employee_id,issued_on);
create table if not exists public.payroll_advance_recoveries (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references public.payroll_advances(id),
  entity_id uuid not null references public.entities(id),
  employee_id uuid not null references public.employees(id),
  zone_id uuid, branch_id uuid, department_id uuid,
  period text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric(10,2) not null check (amount>0 and amount<100000000),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(advance_id,period)
);
create index if not exists payroll_advance_recoveries_month_idx on public.payroll_advance_recoveries(entity_id,period,employee_id);
create table if not exists public.payroll_payments (
  run_id uuid not null references public.payroll_runs(id),
  employee_id uuid not null references public.employees(id),
  entity_id uuid not null references public.entities(id),
  zone_id uuid, branch_id uuid, department_id uuid,
  status text not null default 'unpaid' check (status in ('unpaid','held','paid')),
  hold_reason text,
  paid_at timestamptz,
  payment_reference text,
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(run_id,employee_id),
  check ((status='held' and hold_reason is not null and length(btrim(hold_reason)) between 1 and 500)
    or (status<>'held' and hold_reason is null)),
  check ((status='paid' and paid_at is not null and payment_reference is not null and length(btrim(payment_reference)) between 1 and 200)
    or (status<>'paid' and paid_at is null and payment_reference is null))
);
create index if not exists payroll_payments_entity_idx on public.payroll_payments(entity_id,status);
create table if not exists public.payroll_transaction_history (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null, employee_id uuid not null,
  zone_id uuid, branch_id uuid, department_id uuid,
  source_table text not null, action text not null,
  before_value jsonb, after_value jsonb,
  changed_by uuid, changed_at timestamptz not null default clock_timestamp()
);
create index if not exists payroll_transaction_history_employee_idx on public.payroll_transaction_history(entity_id,employee_id,changed_at);

do $$ declare _table text; begin
  foreach _table in array array['payroll_adjustments','payroll_advances','payroll_advance_recoveries','payroll_payments','payroll_transaction_history'] loop
    execute format('alter table public.%I enable row level security',_table);
    execute format('drop policy if exists payroll_transaction_select on public.%I',_table);
    execute format('create policy payroll_transaction_select on public.%I for select to authenticated using(app.has_perm(''payroll.manage'',entity_id,zone_id,branch_id,department_id,employee_id))',_table);
    execute format('drop policy if exists active_account_required on public.%I',_table);
    execute format('create policy active_account_required on public.%I as restrictive for all to authenticated using(app.session_is_active()) with check(app.session_is_active())',_table);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',_table);
    execute format('grant select on public.%I to authenticated,service_role',_table);
  end loop;
end $$;

-- Recheck employee company and authorization after acquiring the same lock as calculation and
-- publication. Concurrent transfers cannot move a financial entry into an unintended company.
create or replace function app.lock_payroll_employee(_employee uuid)
returns public.employees language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees%rowtype; _entity uuid;
begin
  select * into _emp from public.employees where id=_employee;
  if auth.uid() is null or _emp.id is null or not app.has_perm('payroll.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to manage payroll for this employee.' using errcode='42501';
  end if;
  _entity:=_emp.entity_id; perform app.lock_payroll(_entity);
  select * into _emp from public.employees where id=_employee;
  if _emp.entity_id is distinct from _entity then
    raise exception 'Employee company changed. Reload before saving.' using errcode='40001';
  end if;
  if not app.has_perm('payroll.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to manage payroll for this employee.' using errcode='42501';
  end if;
  return _emp;
end $$;

create or replace function app.validate_payroll_transaction_amount(_amount numeric,_allow_zero boolean default false)
returns void language plpgsql immutable set search_path=pg_catalog as $$
begin
  if _amount is null or _amount<0 or (not _allow_zero and _amount=0) or _amount>=100000000 or _amount<>round(_amount,2) then
    raise exception 'Enter a valid amount with at most two decimal places.' using errcode='23514';
  end if;
end $$;

create or replace function app.tg_payroll_transaction_history()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _row jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.payroll_transaction_history(entity_id,employee_id,zone_id,branch_id,department_id,source_table,action,before_value,after_value,changed_by)
    values((_row->>'entity_id')::uuid,(_row->>'employee_id')::uuid,(_row->>'zone_id')::uuid,(_row->>'branch_id')::uuid,(_row->>'department_id')::uuid,
      tg_table_name,tg_op,case when tg_op='INSERT' then null else to_jsonb(old) end,case when tg_op='DELETE' then null else to_jsonb(new) end,auth.uid());
  return null;
end $$;
drop trigger if exists payroll_transaction_history_immutable on public.payroll_transaction_history;
create trigger payroll_transaction_history_immutable before update or delete on public.payroll_transaction_history
  for each row execute function app.tg_payroll_hour_history_immutable();

-- This also protects against service imports bypassing the RPC layer.
create or replace function app.tg_payroll_transaction_source_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _row jsonb; _advance public.payroll_advances%rowtype; _emp public.employees%rowtype; _period text; _entity uuid; _employee uuid;
begin
  if tg_op='UPDATE' and row(old.id,old.entity_id,old.employee_id,old.period) is distinct from row(new.id,new.entity_id,new.employee_id,new.period) then
    raise exception 'Payroll entry identity cannot be changed.' using errcode='55000';
  end if;
  _row:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  _entity:=(_row->>'entity_id')::uuid; _employee:=(_row->>'employee_id')::uuid; _period:=_row->>'period';
  perform app.payroll_period_start(_period); perform app.lock_payroll(_entity);
  if exists(select 1 from public.payroll_runs where entity_id=_entity and period=_period and status='Published')
    or exists(select 1 from public.payslips where employee_id=_employee and period=_period and status='Published') then
    raise exception 'Published payroll adjustments and advance recoveries cannot be changed.' using errcode='55000';
  end if;
  if tg_op<>'DELETE' then
    select * into _emp from public.employees where id=_employee;
    if row(_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id) is distinct from
      row(new.entity_id,new.zone_id,new.branch_id,new.department_id) then
      raise exception 'Employee scope changed. Reload before saving.' using errcode='40001';
    end if;
    if not exists(select 1 from app.payroll_employee_windows(_entity,app.payroll_period_start(_period),
        (app.payroll_period_start(_period)+interval '1 month - 1 day')::date) w where w.employee_id=_employee) then
      raise exception 'Choose a payroll month within this employee''s employment.' using errcode='23514';
    end if;
    if tg_table_name='payroll_advance_recoveries' then
      if tg_op='UPDATE' and old.advance_id is distinct from new.advance_id then
        raise exception 'Recovery advance cannot be changed.' using errcode='55000';
      end if;
      select * into _advance from public.payroll_advances where id=new.advance_id;
      if row(_advance.entity_id,_advance.employee_id) is distinct from row(new.entity_id,new.employee_id) then
        raise exception 'Advance does not belong to this employee and company.' using errcode='23514';
      end if;
      if _advance.voided_at is not null then raise exception 'A voided advance cannot be recovered.' using errcode='23514'; end if;
      if _period<to_char(_advance.issued_on,'YYYY-MM') then
        raise exception 'Recovery cannot precede the advance issue month.' using errcode='23514';
      end if;
      if new.amount+coalesce((select sum(amount) from public.payroll_advance_recoveries where advance_id=new.advance_id and id<>new.id),0)>_advance.amount then
        raise exception 'Recoveries exceed the issued advance. Reduce or reschedule another recovery.' using errcode='23514';
      end if;
      if exists(select 1 from public.payroll_monthly_inputs where employee_id=_employee and period=_period and advance_recovery>0) then
        raise exception 'Clear the manual advance recovery before scheduling a ledger recovery.' using errcode='23514';
      end if;
    end if;
  end if;
  update public.payroll_runs set needs_recalculation=true where entity_id=_entity and period=_period and status='Draft';
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create or replace function app.tg_payroll_advance_immutable()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
begin
  if tg_op='UPDATE' and old.voided_at is null and new.voided_at is not null
    and (to_jsonb(old)-array['voided_at','void_reason','updated_at'])=(to_jsonb(new)-array['voided_at','void_reason','updated_at']) then
    perform app.lock_payroll(old.entity_id);
    if exists(select 1 from public.payroll_advance_recoveries where advance_id=old.id) then
      raise exception 'Clear all draft recovery schedules before voiding an unused advance. Published recoveries cannot be reversed.' using errcode='23514';
    end if;
    return new;
  end if;
  raise exception 'Issued advances are immutable financial records.' using errcode='55000';
end $$;
drop trigger if exists payroll_advance_immutable on public.payroll_advances;
create trigger payroll_advance_immutable before update or delete on public.payroll_advances
  for each row execute function app.tg_payroll_advance_immutable();

create or replace function app.tg_payroll_manual_advance_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
begin
  perform app.lock_payroll(new.entity_id);
  if new.advance_recovery>0 and exists(select 1 from public.payroll_advance_recoveries where employee_id=new.employee_id and period=new.period) then
    raise exception 'This month already has scheduled advance recoveries. Clear them before using a manual recovery.' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists payroll_manual_advance_guard on public.payroll_monthly_inputs;
create trigger payroll_manual_advance_guard before insert or update on public.payroll_monthly_inputs
  for each row execute function app.tg_payroll_manual_advance_guard();

do $$ declare _table text; begin
  foreach _table in array array['payroll_adjustments','payroll_advance_recoveries'] loop
    execute format('drop trigger if exists payroll_transaction_source_guard on public.%I',_table);
    execute format('create trigger payroll_transaction_source_guard before insert or update or delete on public.%I for each row execute function app.tg_payroll_transaction_source_guard()',_table);
  end loop;
  foreach _table in array array['payroll_adjustments','payroll_advances','payroll_advance_recoveries','payroll_payments'] loop
    execute format('drop trigger if exists payroll_transaction_audit on public.%I',_table);
    execute format('create trigger payroll_transaction_audit after insert or update or delete on public.%I for each row execute function app.tg_payroll_transaction_history()',_table);
  end loop;
end $$;

create or replace function public.save_payroll_adjustment(_employee_id uuid,_period text,_adjustment jsonb,_id uuid default null,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees%rowtype; _old public.payroll_adjustments%rowtype; _row public.payroll_adjustments%rowtype; _amount numeric; _kind text; _reason text;
begin
  perform app.payroll_period_start(_period);
  _emp:=app.lock_payroll_employee(_employee_id);
  if jsonb_typeof(_adjustment) is distinct from 'object' or exists(select 1 from jsonb_object_keys(_adjustment) k where k not in ('kind','amount','reason')) then
    raise exception 'Invalid adjustment fields.' using errcode='22023';
  end if;
  _amount:=(_adjustment->>'amount')::numeric; _kind:=_adjustment->>'kind'; _reason:=nullif(btrim(_adjustment->>'reason'),'');
  perform app.validate_payroll_transaction_amount(_amount);
  if _kind is null or _kind not in ('bonus','incentive','deduction') or _reason is null or length(_reason)>500 then
    raise exception 'Choose an adjustment type and enter a reason (up to 500 characters).' using errcode='23514';
  end if;
  select * into _old from public.payroll_adjustments where id=_id;
  if _old.id is not null and row(_old.employee_id,_old.entity_id,_old.period) is distinct from row(_employee_id,_emp.entity_id,_period) then
    raise exception 'Adjustment does not belong to this employee and payroll month.' using errcode='42501';
  end if;
  -- A client-chosen creation ID makes an identical retried submission harmless.
  if _old.id is not null and _expected_updated_at is null and _old.created_by=auth.uid()
    and _old.created_at=_old.updated_at and row(_old.kind,_old.amount,_old.reason) is not distinct from row(_kind,_amount,_reason) then return to_jsonb(_old); end if;
  if _old.updated_at is distinct from _expected_updated_at then
    raise exception 'Adjustment changed in another session. Reload before saving.' using errcode='40001';
  end if;
  if _old.id is null then
    insert into public.payroll_adjustments(id,entity_id,employee_id,zone_id,branch_id,department_id,period,kind,amount,reason,created_by,updated_by,created_at,updated_at)
      values(coalesce(_id,gen_random_uuid()),_emp.entity_id,_emp.id,_emp.zone_id,_emp.branch_id,_emp.department_id,_period,_kind,_amount,_reason,auth.uid(),auth.uid(),now(),now()) returning * into _row;
  else
    update public.payroll_adjustments set kind=_kind,amount=_amount,reason=_reason,zone_id=_emp.zone_id,branch_id=_emp.branch_id,department_id=_emp.department_id,
      updated_by=auth.uid(),updated_at=clock_timestamp() where id=_old.id returning * into _row;
  end if;
  return to_jsonb(_row);
end $$;

create or replace function public.delete_payroll_adjustment(_id uuid,_expected_updated_at timestamptz)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _row public.payroll_adjustments%rowtype;
begin
  select * into _row from public.payroll_adjustments where id=_id;
  if auth.uid() is null or _row.id is null or not app.has_perm('payroll.manage',_row.entity_id,_row.zone_id,_row.branch_id,_row.department_id,_row.employee_id) then
    raise exception 'Not authorized to remove this adjustment.' using errcode='42501';
  end if;
  perform app.lock_payroll(_row.entity_id);
  select * into _row from public.payroll_adjustments where id=_id;
  if _row.updated_at is distinct from _expected_updated_at or _row.id is null then
    raise exception 'Adjustment changed in another session. Reload before deleting.' using errcode='40001';
  end if;
  if not app.has_perm('payroll.manage',_row.entity_id,_row.zone_id,_row.branch_id,_row.department_id,_row.employee_id) then
    raise exception 'Not authorized to remove this adjustment.' using errcode='42501';
  end if;
  delete from public.payroll_adjustments where id=_id;
end $$;

create or replace function public.create_payroll_advance(_employee_id uuid,_issued_on date,_amount numeric,_reason text,_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees%rowtype; _row public.payroll_advances%rowtype;
begin
  _emp:=app.lock_payroll_employee(_employee_id);
  perform app.validate_payroll_transaction_amount(_amount);
  _reason:=nullif(btrim(_reason),'');
  if _issued_on is null or not isfinite(_issued_on) or _reason is null or length(_reason)>500 or _request_id is null then
    raise exception 'Enter the advance issue date, amount and reason.' using errcode='23514';
  end if;
  select * into _row from public.payroll_advances where request_id=_request_id;
  if _row.id is not null then
    if row(_row.entity_id,_row.employee_id,_row.issued_on,_row.amount,_row.reason,_row.created_by) is not distinct from
      row(_emp.entity_id,_employee_id,_issued_on,_amount,_reason,auth.uid()) then return to_jsonb(_row); end if;
    raise exception 'This advance request was already used with different details. Reload before saving.' using errcode='40001';
  end if;
  insert into public.payroll_advances(request_id,entity_id,employee_id,zone_id,branch_id,department_id,issued_on,amount,reason,created_by)
    values(_request_id,_emp.entity_id,_emp.id,_emp.zone_id,_emp.branch_id,_emp.department_id,_issued_on,_amount,_reason,auth.uid()) returning * into _row;
  return to_jsonb(_row);
end $$;

create or replace function public.void_payroll_advance(_id uuid,_reason text,_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _row public.payroll_advances%rowtype;
begin
  select * into _row from public.payroll_advances where id=_id;
  if auth.uid() is null or _row.id is null or not app.has_perm('payroll.manage',_row.entity_id,_row.zone_id,_row.branch_id,_row.department_id,_row.employee_id) then
    raise exception 'Not authorized to void this advance.' using errcode='42501';
  end if;
  perform app.lock_payroll(_row.entity_id);
  select * into _row from public.payroll_advances where id=_id;
  if _row.updated_at is distinct from _expected_updated_at then
    raise exception 'Advance changed in another session. Reload before voiding.' using errcode='40001';
  end if;
  if not app.has_perm('payroll.manage',_row.entity_id,_row.zone_id,_row.branch_id,_row.department_id,_row.employee_id) then
    raise exception 'Not authorized to void this advance.' using errcode='42501';
  end if;
  _reason:=nullif(btrim(_reason),'');
  if _reason is null or length(_reason)>500 then raise exception 'Enter a reason for voiding the unused advance.' using errcode='23514'; end if;
  update public.payroll_advances set voided_at=clock_timestamp(),void_reason=_reason,updated_at=clock_timestamp() where id=_id returning * into _row;
  return to_jsonb(_row);
end $$;

-- Scoped managers can distinguish posted recovery without reading company payroll totals.
create or replace function public.get_payroll_advance_recoveries(_entity_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _rows jsonb;
begin
  if auth.uid() is null or not app.has_perm_any_scope('payroll.manage') then
    raise exception 'Not authorized to view advance recoveries.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('posted',exists(select 1 from public.payroll_runs p
      where p.entity_id=r.entity_id and p.period=r.period and p.status='Published')) order by r.period,r.id),'[]'::jsonb)
    into _rows from public.payroll_advance_recoveries r where r.entity_id=_entity_id
      and app.has_perm('payroll.manage',r.entity_id,r.zone_id,r.branch_id,r.department_id,r.employee_id);
  return _rows;
end $$;

create or replace function public.save_payroll_advance_recovery(_advance_id uuid,_period text,_amount numeric,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _advance public.payroll_advances%rowtype; _emp public.employees%rowtype; _row public.payroll_advance_recoveries%rowtype;
begin
  perform app.payroll_period_start(_period); perform app.validate_payroll_transaction_amount(_amount,true);
  select * into _advance from public.payroll_advances where id=_advance_id;
  if auth.uid() is null or _advance.id is null or not app.has_perm('payroll.manage',_advance.entity_id,_advance.zone_id,_advance.branch_id,_advance.department_id,_advance.employee_id) then
    raise exception 'Not authorized to manage this advance.' using errcode='42501';
  end if;
  perform app.lock_payroll(_advance.entity_id);
  if not app.has_perm('payroll.manage',_advance.entity_id,_advance.zone_id,_advance.branch_id,_advance.department_id,_advance.employee_id) then
    raise exception 'Not authorized to manage this advance.' using errcode='42501';
  end if;
  select * into _row from public.payroll_advance_recoveries where advance_id=_advance_id and period=_period;
  if _row.updated_at is distinct from _expected_updated_at then
    raise exception 'Advance recovery changed in another session. Reload before saving.' using errcode='40001';
  end if;
  if _amount=0 then
    if _row.id is not null then delete from public.payroll_advance_recoveries where id=_row.id; end if;
    return null;
  end if;
  select * into _emp from public.employees where id=_advance.employee_id;
  if _emp.entity_id is distinct from _advance.entity_id then
    raise exception 'Employee moved company. Clear the old schedule and resolve the advance with the originating company.' using errcode='23514';
  end if;
  if not app.has_perm('payroll.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to manage payroll for this employee.' using errcode='42501';
  end if;
  if _row.id is null then
    insert into public.payroll_advance_recoveries(advance_id,entity_id,employee_id,zone_id,branch_id,department_id,period,amount,created_by,updated_by)
      values(_advance_id,_emp.entity_id,_emp.id,_emp.zone_id,_emp.branch_id,_emp.department_id,_period,_amount,auth.uid(),auth.uid()) returning * into _row;
  else
    update public.payroll_advance_recoveries set amount=_amount,zone_id=_emp.zone_id,branch_id=_emp.branch_id,department_id=_emp.department_id,
      updated_by=auth.uid(),updated_at=clock_timestamp() where id=_row.id returning * into _row;
  end if;
  return to_jsonb(_row);
end $$;

create or replace function app.tg_payroll_payment_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _slip public.payslips%rowtype;
begin
  if tg_op='DELETE' then raise exception 'Payment records cannot be deleted.' using errcode='55000'; end if;
  if tg_op='UPDATE' then
    if old.status='paid' then raise exception 'Recorded payments are immutable.' using errcode='55000'; end if;
    if old.status='held' and new.status='paid' then raise exception 'Release the salary hold before recording payment.' using errcode='23514'; end if;
    if row(old.run_id,old.employee_id,old.entity_id,old.zone_id,old.branch_id,old.department_id) is distinct from
      row(new.run_id,new.employee_id,new.entity_id,new.zone_id,new.branch_id,new.department_id) then
      raise exception 'Payment identity cannot be changed.' using errcode='55000';
    end if;
  elsif new.status<>'unpaid' then raise exception 'New payment records must start unpaid.' using errcode='23514'; end if;
  perform app.lock_payroll(new.entity_id);
  select p.* into _slip from public.payslips p join public.payroll_runs r on r.id=p.run_id where p.run_id=new.run_id and p.employee_id=new.employee_id
    and p.status='Published' and r.status='Published';
  if _slip.id is null or row(_slip.entity_id,_slip.zone_id,_slip.branch_id,_slip.department_id) is distinct from
    row(new.entity_id,new.zone_id,new.branch_id,new.department_id) then
    raise exception 'Payment tracking requires a published payslip for this employee.' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists payroll_payment_guard on public.payroll_payments;
create trigger payroll_payment_guard before insert or update or delete on public.payroll_payments
  for each row execute function app.tg_payroll_payment_guard();

create or replace function public.set_payroll_payment_status(_run_id uuid,_employee_id uuid,_status text,_reason text default null,_reference text default null,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _slip public.payslips%rowtype; _row public.payroll_payments%rowtype;
begin
  select * into _slip from public.payslips where run_id=_run_id and employee_id=_employee_id;
  if auth.uid() is null or _slip.id is null or not app.has_perm('payroll.manage',_slip.entity_id,_slip.zone_id,_slip.branch_id,_slip.department_id,_slip.employee_id) then
    raise exception 'Not authorized to manage this salary payment.' using errcode='42501';
  end if;
  perform app.lock_payroll(_slip.entity_id);
  select * into _slip from public.payslips where run_id=_run_id and employee_id=_employee_id;
  if _slip.id is null or _slip.status<>'Published' or not exists(select 1 from public.payroll_runs where id=_run_id and status='Published') then
    raise exception 'Publish and review payroll before tracking payments.' using errcode='23514';
  end if;
  if not app.has_perm('payroll.manage',_slip.entity_id,_slip.zone_id,_slip.branch_id,_slip.department_id,_slip.employee_id) then
    raise exception 'Not authorized to manage this salary payment.' using errcode='42501';
  end if;
  _reason:=nullif(btrim(_reason),''); _reference:=nullif(btrim(_reference),'');
  if _status is null or _status not in ('unpaid','held','paid') or (_status='held' and (_reason is null or length(_reason)>500))
    or (_status='paid' and (_reference is null or length(_reference)>200)) then
    raise exception 'Choose a valid status. A hold needs a reason; a payment needs a reference.' using errcode='23514';
  end if;
  select * into _row from public.payroll_payments where run_id=_run_id and employee_id=_employee_id;
  if _row.updated_at is distinct from _expected_updated_at then
    raise exception 'Payment status changed in another session. Reload before saving.' using errcode='40001';
  end if;
  if _row.run_id is null then
    insert into public.payroll_payments(run_id,employee_id,entity_id,zone_id,branch_id,department_id,updated_by)
      values(_run_id,_employee_id,_slip.entity_id,_slip.zone_id,_slip.branch_id,_slip.department_id,auth.uid()) returning * into _row;
  end if;
  if _row.status='paid' then raise exception 'This salary payment has already been recorded.' using errcode='55000'; end if;
  update public.payroll_payments set status=_status,hold_reason=case when _status='held' then _reason end,
    payment_reference=case when _status='paid' then _reference end,paid_at=case when _status='paid' then clock_timestamp() end,
    updated_by=auth.uid(),updated_at=clock_timestamp() where run_id=_run_id and employee_id=_employee_id returning * into _row;
  return to_jsonb(_row);
end $$;
create or replace function public.run_payroll(_entity_id uuid,_period text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _from date := app.payroll_period_start(_period); _to date; _days int; _start date; _end date;
  _run_id uuid; _payslip_id uuid; _emp record; _sal public.salary_structures%rowtype; _comp record; _named record;
  _policy public.payroll_policies%rowtype; _input public.payroll_monthly_inputs%rowtype;
  _configured boolean; _stats record; _full_working numeric; _divisor numeric; _factor numeric;
  _paid numeric; _lop numeric; _salary numeric; _basic numeric; _earn numeric; _ded numeric; _employer numeric;
  _structure_total numeric; _base numeric; _amount numeric; _rate numeric; _hour_rate numeric;
  _ot numeric; _late numeric; _effective_ot numeric; _effective_late numeric; _pf numeric; _esi numeric; _other_ded numeric; _advance numeric; _welfare numeric;
  _adjustment record; _bonus numeric; _adjustment_incentive numeric; _adjustment_deductions numeric; _ledger_advance numeric;
  _count int:=0; _sum_gross numeric:=0; _sum_net numeric:=0; _register jsonb; _key text; _label text;
begin
  if auth.uid() is null and current_setting('role',true) in ('authenticated','anon') then
    raise exception 'Sign in to run payroll.' using errcode='42501';
  end if;
  if auth.uid() is not null and not app.has_perm('payroll.manage',_entity_id,null,null,null,null) then
    raise exception 'Not authorized to run payroll for this company.' using errcode='42501';
  end if;
  if _entity_id is null or not exists(select 1 from public.entities where id=_entity_id) then
    raise exception 'Choose a valid company.' using errcode='22023';
  end if;
  perform app.lock_payroll(_entity_id);
  _to := (_from+interval '1 month - 1 day')::date; _days := extract(day from _to)::int;
  select * into _policy from public.payroll_policies where entity_id=_entity_id;
  _configured := found;
  if not _configured then
    _policy.divisor_mode:='calendar'; _policy.fixed_days:=30; _policy.hours_per_day:=8;
    _policy.ot_multiplier:=2; _policy.deduct_late:=false;
  end if;
  insert into public.payroll_runs(entity_id,period,status,run_by) values(_entity_id,_period,'Draft',auth.uid())
    on conflict(entity_id,period) do update set run_by=excluded.run_by where public.payroll_runs.status='Draft'
    returning id into _run_id;
  if _run_id is null then raise exception 'Published payroll cannot be regenerated.' using errcode='55000'; end if;
  if exists(select 1 from (
    select employee_id from public.payroll_adjustments where entity_id=_entity_id and period=_period
    union select employee_id from public.payroll_advance_recoveries where entity_id=_entity_id and period=_period
  ) t where not exists(select 1 from app.payroll_employee_windows(_entity_id,_from,_to) w where w.employee_id=t.employee_id)) then
    raise exception 'Some adjustments or advance recoveries belong to employees outside this payroll month. Remove or reschedule them before calculating.' using errcode='23514';
  end if;
  delete from public.payslips where run_id=_run_id;

  for _emp in
    select e.*,b.name as branch_name,w.employment_from,w.employment_to,w.last_day
    from app.payroll_employee_windows(_entity_id,_from,_to) w
    join public.employees e on e.id=w.employee_id left join public.branches b on b.id=e.branch_id
    order by e.id
  loop
    _start:=_emp.employment_from; _end:=_emp.employment_to;
    continue when _end<_start;
    if _emp.status<>'Active' and _emp.last_day is null then
      raise exception 'Complete the last working day for inactive employee % before payroll.',_emp.full_name using errcode='23514';
    end if;
    select * into _sal from public.salary_structures where employee_id=_emp.id and effective_from<=_start
      order by effective_from desc limit 1;
    if _sal.id is null then raise exception 'Set a salary effective on or before % for %.',_start,_emp.full_name using errcode='23514'; end if;
    if exists(select 1 from public.salary_structures where employee_id=_emp.id and effective_from>_start and effective_from<=_end) then
      raise exception 'Midmonth salary revision for % requires a split-period calculation; this run cannot proceed.',_emp.full_name using errcode='23514';
    end if;
    if _sal.gross < 0 or _sal.basic < 0 or _sal.basic>_sal.gross or _sal.gross >= 'Infinity'::numeric then
      raise exception 'Invalid salary for %.',_emp.full_name using errcode='23514';
    end if;

    select * into _stats from app.payroll_attendance_metrics(_emp.id,_start,_end);
    if _stats.pending_recompute_days>0 then
      raise exception 'Attendance changes for % are awaiting recomputation. Refresh attendance before running payroll.',_emp.full_name using errcode='23514';
    end if;
    if _stats.recorded <> (_end-_start+1) then
      raise exception 'Attendance is incomplete for %: % of % employment days. Recompute and review attendance first.',_emp.full_name,_stats.recorded,(_end-_start+1) using errcode='23514';
    end if;
    if _stats.unresolved>0 or _stats.invalid>0 then
      raise exception 'Resolve missing punches, missing shifts, incomplete breaks and invalid day credits for % before payroll.',_emp.full_name using errcode='23514';
    end if;
    _lop:=_stats.lop; _paid:=(_end-_start+1)-_lop;
    if _policy.divisor_mode='working' then
      select count(*) into _full_working from public.attendance where employee_id=_emp.id and work_date between _from and _to and day_type='working';
      if (select count(*) from public.attendance where employee_id=_emp.id and work_date between _from and _to)<>_days or _full_working=0 then
        raise exception 'Working-day divisor needs a complete month calendar, including outside employment, for %.',_emp.full_name using errcode='23514';
      end if;
      _divisor:=_full_working; _factor:=greatest(0,least(1,(_stats.working-_lop)/_divisor));
    elsif _policy.divisor_mode='fixed' then
      _divisor:=_policy.fixed_days; _factor:=greatest(0,least(1,1-(_days-(_end-_start+1)+_lop)/_divisor));
    else
      _divisor:=_days; _factor:=_paid/_days;
    end if;
    _salary:=round(_sal.gross*_factor,2); _basic:=round(_sal.basic*_factor,2);
    _rate:=_sal.gross/_divisor; _hour_rate:=_rate/_policy.hours_per_day;
    select * into _input from public.payroll_monthly_inputs where employee_id=_emp.id and period=_period;
    if coalesce(_input.ot_hours,0)>round(_stats.ot_hours,2) then
      raise exception 'Approved OT hours exceed recorded OT for %.',_emp.full_name using errcode='23514';
    end if;
    if _policy.deduct_late and coalesce(_input.late_hours,0)>round(_stats.deductible_late_hours,2) then
      raise exception 'Approved late hours exceed lateness on fully paid working days for %; do not charge the same time as loss of pay.',_emp.full_name using errcode='23514';
    end if;
    if coalesce(_input.late_hours,0)>0 and not _policy.deduct_late then
      raise exception 'Late deductions are disabled by company policy. Clear approved late hours for % or enable the policy.',_emp.full_name using errcode='23514';
    end if;
    _effective_ot:=coalesce(_input.ot_hours,round(_stats.ot_hours,2));
    _effective_late:=case when _policy.deduct_late then coalesce(_input.late_hours,round(_stats.deductible_late_hours,2)) else 0 end;
    _ot:=round(_effective_ot*_hour_rate*_policy.ot_multiplier,2);
    _late:=round(_effective_late*_hour_rate,2);
    _earn:=_basic; _ded:=0; _employer:=0; _pf:=0; _esi:=0; _other_ded:=0; _advance:=0; _welfare:=0;
    insert into public.payslips(employee_id,period,gross,deductions,net,status,run_id,paid_days,lop_days,employer_cost,
      entity_id,zone_id,branch_id,department_id)
    values(_emp.id,_period,0,0,0,'Draft',_run_id,_paid,_lop,0,_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id)
    on conflict(employee_id,period) do update set run_id=excluded.run_id,paid_days=excluded.paid_days,lop_days=excluded.lop_days,
      status='Draft',entity_id=excluded.entity_id,zone_id=excluded.zone_id,branch_id=excluded.branch_id,department_id=excluded.department_id
    returning id into _payslip_id;
    delete from public.payslip_lines where payslip_id=_payslip_id;
    insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'BASIC','Basic','earning',_basic,1);
    _structure_total:=_sal.basic;
    for _named in select * from app.salary_gross_components(_sal.notes) loop
      _structure_total:=_structure_total+_named.component_amount;
      if _structure_total>_sal.gross then raise exception 'Salary breakdown exceeds agreed monthly salary for %.',_emp.full_name using errcode='23514'; end if;
      _amount:=round(_structure_total*_factor,2)-_earn; _earn:=_earn+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'GROSS_'||_named.component_order,_named.component_name,'earning',_amount,10+_named.component_order); end if;
    end loop;
    for _comp in select * from app.components_for(_emp.id) loop
      continue when _comp.min_gross is not null and _sal.gross<_comp.min_gross;
      continue when _comp.max_gross is not null and _sal.gross>_comp.max_gross;
      -- Manual PF/ESI replace employee deductions with exactly those normalized codes only.
      continue when not _comp.employer_share and _comp.kind='deduction' and
        ((upper(btrim(_comp.code))='PF' and _input.pf is not null) or (upper(btrim(_comp.code))='ESI' and _input.esi is not null));
      _base:=case _comp.calc_type when 'percent_of_basic' then case when _comp.prorate_on_lop then _basic else _sal.basic end
        when 'percent_of_gross' then case when _comp.prorate_on_lop then _salary else _sal.gross end else 0 end;
      if _comp.cap_base is not null then _base:=least(_base,_comp.cap_base); end if;
      _amount:=case when _comp.calc_type='fixed' then round(coalesce(_comp.amount,0)*case when _comp.prorate_on_lop then _factor else 1 end,2)
        else round(_base*coalesce(_comp.rate,0)/100,2) end;
      if _comp.max_amount is not null then _amount:=least(_amount,_comp.max_amount); end if;
      if _amount<0 or _amount>='Infinity'::numeric then raise exception 'Invalid pay component %.',_comp.code using errcode='23514'; end if;
      continue when _amount=0;
      if _comp.employer_share then _employer:=_employer+_amount;
      elsif _comp.kind='earning' then _earn:=_earn+_amount;
      else
        _ded:=_ded+_amount;
        case upper(btrim(_comp.code)) when 'PF' then _pf:=_pf+_amount; when 'ESI' then _esi:=_esi+_amount;
          else _other_ded:=_other_ded+_amount; end case;
      end if;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,_comp.code,_comp.name,
        case when _comp.employer_share then 'employer' else _comp.kind end,_amount,
        case when _comp.employer_share then 700 when _comp.kind='deduction' then 500 else 100 end+_comp.display_order);
    end loop;
    if _earn>_salary then raise exception 'Recurring earning components exceed earned salary for %. Review the salary breakdown.',_emp.full_name using errcode='23514'; end if;
    if _earn<_salary then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
      values(_payslip_id,'OTHER','Other allowances within salary','earning',_salary-_earn,300); end if;
    _earn:=_salary;
    for _key,_label in select * from (values ('incentive','Incentive'),('target_incentive','Target incentive'),('tea_expense','Tea expense'),
      ('other_allowances','Additional other allowances'),('travel_food','Travel allowance / food expense'),('rent_commission','Rent / commission'),
      ('special_allowance','Special allowance')) v(k,label) loop
      _amount:=coalesce((to_jsonb(_input)->>_key)::numeric,0); _earn:=_earn+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'MONTHLY_'||upper(_key),_label,'earning',_amount,350); end if;
    end loop;
    _bonus:=0; _adjustment_incentive:=0; _adjustment_deductions:=0;
    for _adjustment in select * from public.payroll_adjustments where entity_id=_entity_id and employee_id=_emp.id and period=_period order by id loop
      if _adjustment.kind='deduction' then
        _ded:=_ded+_adjustment.amount; _other_ded:=_other_ded+_adjustment.amount;
        _adjustment_deductions:=_adjustment_deductions+_adjustment.amount;
      else
        _earn:=_earn+_adjustment.amount;
        if _adjustment.kind='bonus' then _bonus:=_bonus+_adjustment.amount;
        else _adjustment_incentive:=_adjustment_incentive+_adjustment.amount; end if;
      end if;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'ADJUSTMENT_'||_adjustment.id,initcap(_adjustment.kind)||': '||_adjustment.reason,
          case when _adjustment.kind='deduction' then 'deduction' else 'earning' end,_adjustment.amount,case when _adjustment.kind='deduction' then 580 else 380 end);
    end loop;
    _earn:=_earn+_ot;
    if _ot<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'OT','Overtime','earning',_ot,390); end if;
    if _input.pf is not null then _pf:=_input.pf; _ded:=_ded+_pf;
      if _pf<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'PF','PF (approved amount)','deduction',_pf,501); end if;
    end if;
    if _input.esi is not null then _esi:=_input.esi; _ded:=_ded+_esi;
      if _esi<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order) values(_payslip_id,'ESI','ESI (approved amount)','deduction',_esi,502); end if;
    end if;
    select coalesce(sum(amount),0) into _ledger_advance from public.payroll_advance_recoveries
      where entity_id=_entity_id and employee_id=_emp.id and period=_period;
    if _ledger_advance>0 and coalesce(_input.advance_recovery,0)>0 then
      raise exception 'Clear the manual advance recovery for % before using scheduled advance recoveries.',_emp.full_name using errcode='23514';
    end if;
    _advance:=coalesce(_input.advance_recovery,0)+_ledger_advance; _welfare:=coalesce(_input.welfare_fund,0);
    _other_ded:=_other_ded+coalesce(_input.other_deductions,0);
    for _key,_label,_amount in select * from (values ('LATE','Approved late deduction',_late),('ADVANCE','Manual salary advance recovery',coalesce(_input.advance_recovery,0)),
      ('WELFARE','Welfare fund',_welfare),('MONTHLY_OTHER_DEDUCTIONS','Loss, damages / other approved deductions',coalesce(_input.other_deductions,0))) v(k,label,amount) loop
      _ded:=_ded+_amount;
      if _amount<>0 then insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,_key,_label,'deduction',_amount,590); end if;
    end loop;
    for _adjustment in select r.*,a.reason from public.payroll_advance_recoveries r join public.payroll_advances a on a.id=r.advance_id
      where r.entity_id=_entity_id and r.employee_id=_emp.id and r.period=_period order by r.id loop
      _ded:=_ded+_adjustment.amount;
      insert into public.payslip_lines(payslip_id,code,name,kind,amount,sort_order)
        values(_payslip_id,'ADVANCE_'||_adjustment.advance_id,'Advance recovery: '||_adjustment.reason,'deduction',_adjustment.amount,591);
    end loop;
    if _ded>_earn then raise exception 'Deductions exceed gross salary for %. Review recoveries before payroll.',_emp.full_name using errcode='23514'; end if;
    _register:=jsonb_build_object('employee_name',_emp.full_name,'employee_code',_emp.employee_code,'branch',coalesce(_emp.branch_name,''),
      'salary',_sal.gross,'days_per_month',_days,'net_working_days',_stats.working,'public_holiday',_stats.holidays,
      'actual_working_days',_stats.working-_lop-_stats.paid_leave,'off_days',_stats.offs,'casual_leave',_stats.casual_leave,
      'total_working_days',_paid,'per_day_wages',round(_rate,6),'per_day_working_hour',_policy.hours_per_day,
      'total_working_hours',round(_stats.worked_hours,2),'per_hour_wages',round(_hour_rate,6),'earned_salary',_salary,
      'incentive',coalesce(_input.incentive,0)+_adjustment_incentive,'target_incentive',coalesce(_input.target_incentive,0),'tea_expense',coalesce(_input.tea_expense,0),
      'other_allowances',coalesce(_input.other_allowances,0),'travel_food',coalesce(_input.travel_food,0),'rent_commission',coalesce(_input.rent_commission,0),
      'special_allowance',coalesce(_input.special_allowance,0),'ot_hours',_effective_ot,'ot_amount',_ot,
      'late_hours',_effective_late,'late_amount',_late,'gross_salary',_earn,'pf',_pf,'esi',_esi,
      'advance_recovery',_advance,'welfare_fund',_welfare,'other_deductions',_other_ded,'net_pay_salary',_earn-_ded)
      || jsonb_build_object('paid_leave',_stats.paid_leave,'lop_days',_lop,'divisor_days',_divisor,'employment_from',_start,'employment_to',_end,
        'paid_hours',round(_paid*_policy.hours_per_day,2),'recorded_worked_hours',round(_stats.worked_hours,2),'recorded_ot_hours',round(_stats.ot_hours,2),'recorded_late_hours',round(_stats.late_hours,2),
        'recorded_deductible_late_hours',round(_stats.deductible_late_hours,2),
        'ot_source',case when _input.ot_hours is null then 'attendance' else 'override' end,
        'late_source',case when _input.late_hours is null then 'attendance' else 'override' end,
        'bonus',_bonus,'adjustment_incentive',_adjustment_incentive,'adjustment_deductions',_adjustment_deductions,'ledger_advance_recovery',_ledger_advance,
        'policy',to_jsonb(_policy),'policy_configured',_configured,'notes',_input.notes,'schema_version',3);
    update public.payslips set gross=_earn,deductions=_ded,net=_earn-_ded,employer_cost=_employer,payroll_register=_register where id=_payslip_id;
    _count:=_count+1; _sum_gross:=_sum_gross+_earn; _sum_net:=_sum_net+(_earn-_ded);
  end loop;
  update public.payroll_runs set employees=_count,total_gross=_sum_gross,total_net=_sum_net,needs_recalculation=false,
    source_fingerprint=app.payroll_source_fingerprint(_entity_id,_period) where id=_run_id;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'GENERATED:'||_period,'payroll_runs',_run_id,_entity_id);
  return jsonb_build_object('run_id',_run_id,'period',_period,'employees',_count,'total_gross',_sum_gross,'total_net',_sum_net,'policy_configured',_configured);
end $$;

create or replace function app.payroll_source_fingerprint(_entity uuid,_period text)
returns text language sql stable security definer set search_path=pg_catalog,public,app as $$
  select md5(jsonb_build_object(
    'adjustments',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_adjustments t where entity_id=_entity and period=_period),
    'advance_recoveries',(select jsonb_agg(to_jsonb(t) order by id) from public.payroll_advance_recoveries t where entity_id=_entity and period=_period),
    'policy',(select to_jsonb(p) from public.payroll_policies p where entity_id=_entity),
    'inputs',(select jsonb_agg(to_jsonb(i) order by employee_id) from public.payroll_monthly_inputs i where entity_id=_entity and period=_period),
    'employees',(select jsonb_agg(jsonb_build_object('id',e.id,'entity',e.entity_id,'branch',e.branch_id,'zone',e.zone_id,
      'department',e.department_id,'name',e.full_name,'code',e.employee_code,'join',e.join_date,'status',e.status) order by e.id)
      from public.employees e where entity_id=_entity),
    'salaries',(select jsonb_agg(to_jsonb(s) order by s.id) from public.salary_structures s join public.employees e on e.id=s.employee_id
      where e.entity_id=_entity and s.effective_from < app.payroll_period_start(_period)+interval '1 month'),
    'components',(select jsonb_agg(to_jsonb(c) order by id) from public.pay_components c where entity_id is null or entity_id=_entity),
    'attendance',(select jsonb_agg(to_jsonb(a) order by a.id) from public.attendance a join public.employees e on e.id=a.employee_id
      where e.entity_id=_entity and a.work_date >= app.payroll_period_start(_period) and a.work_date < app.payroll_period_start(_period)+interval '1 month'),
    'leaves',(select jsonb_agg(to_jsonb(l) order by l.id) from public.leaves l join public.employees e on e.id=l.employee_id
      where e.entity_id=_entity and l.start_date < app.payroll_period_start(_period)+interval '1 month' and l.end_date >= app.payroll_period_start(_period)),
    'regularizations',(select jsonb_agg(to_jsonb(r) order by r.id) from public.attendance_regularizations r join public.employees e on e.id=r.employee_id
      where e.entity_id=_entity and r.work_date>=app.payroll_period_start(_period) and r.work_date<app.payroll_period_start(_period)+interval '1 month'),
    'recompute',(select jsonb_agg(to_jsonb(q) order by q.id) from public.attendance_recompute_queue q left join public.employees e on e.id=q.employee_id
      where (e.entity_id=_entity or q.employee_id is null) and q.work_date>=app.payroll_period_start(_period) and q.work_date<app.payroll_period_start(_period)+interval '1 month'),
    'exits',(select jsonb_agg(to_jsonb(x) order by x.id) from public.exits x join public.employees e on e.id=x.employee_id where e.entity_id=_entity)
  )::text);
$$;

create or replace function public.publish_payroll(_run_id uuid,_expected_fingerprint text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _run public.payroll_runs%rowtype; _from date;
begin
  if auth.uid() is null and current_setting('role',true) in ('authenticated','anon') then
    raise exception 'Sign in to publish payroll.' using errcode='42501';
  end if;
  select * into _run from public.payroll_runs where id=_run_id;
  if _run.id is null then raise exception 'Payroll run not found.' using errcode='P0002'; end if;
  if auth.uid() is not null and not app.has_perm('payroll.manage',_run.entity_id,null,null,null,null) then
    raise exception 'Not authorized to publish payroll for this company.' using errcode='42501';
  end if;
  perform app.lock_payroll(_run.entity_id);
  select * into _run from public.payroll_runs where id=_run_id for update;
  if _run.status='Published' then return; end if;
  if _expected_fingerprint is null or _expected_fingerprint is distinct from _run.source_fingerprint then
    raise exception 'This draft changed since review. Reload the register and review its latest totals before publishing.' using errcode='40001';
  end if;
  if not exists(select 1 from public.payroll_policies where entity_id=_run.entity_id) then
    raise exception 'Save the company payroll policy and regenerate this draft before publishing.' using errcode='23514';
  end if;
  if _run.needs_recalculation or _run.source_fingerprint is distinct from app.payroll_source_fingerprint(_run.entity_id,_run.period) then
    raise exception 'Payroll sources changed. Regenerate and review this draft before publishing.' using errcode='55000';
  end if;
  if _run.employees=0 or not exists(select 1 from public.payslips where run_id=_run_id) then
    raise exception 'An empty payroll cannot be published.' using errcode='23514';
  end if;
  if exists(select 1 from public.payslips p where p.run_id=_run_id and (p.status<>'Draft' or p.payroll_register is null or p.net<0
    or not p.payroll_register ?& array['employee_name','branch','salary','days_per_month','net_working_days','public_holiday',
      'actual_working_days','off_days','casual_leave','total_working_days','per_day_wages','per_day_working_hour','total_working_hours',
      'per_hour_wages','earned_salary','incentive','target_incentive','tea_expense','other_allowances','travel_food','rent_commission',
      'special_allowance','ot_hours','ot_amount','late_hours','late_amount','gross_salary','pf','esi','advance_recovery','welfare_fund','other_deductions','net_pay_salary']
    or p.gross is distinct from (p.payroll_register->>'gross_salary')::numeric
    or p.net is distinct from (p.payroll_register->>'net_pay_salary')::numeric
    or p.gross is distinct from ((p.payroll_register->>'earned_salary')::numeric+(p.payroll_register->>'incentive')::numeric
      +(p.payroll_register->>'target_incentive')::numeric+(p.payroll_register->>'tea_expense')::numeric
      +(p.payroll_register->>'other_allowances')::numeric+(p.payroll_register->>'travel_food')::numeric
      +(p.payroll_register->>'rent_commission')::numeric+(p.payroll_register->>'special_allowance')::numeric+(p.payroll_register->>'ot_amount')::numeric+coalesce((p.payroll_register->>'bonus')::numeric,0))
    or p.deductions is distinct from ((p.payroll_register->>'pf')::numeric+(p.payroll_register->>'esi')::numeric
      +(p.payroll_register->>'advance_recovery')::numeric+(p.payroll_register->>'welfare_fund')::numeric
      +(p.payroll_register->>'other_deductions')::numeric+(p.payroll_register->>'late_amount')::numeric)
    or p.gross is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='earning')
    or p.deductions is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='deduction')
    or p.employer_cost is distinct from (select coalesce(sum(l.amount),0) from public.payslip_lines l where l.payslip_id=p.id and l.kind='employer')
    or p.net is distinct from p.gross-p.deductions)) then
    raise exception 'Payroll totals or register do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  if exists(select 1 from public.payslips p where p.run_id=_run_id and (
    p.payroll_register->>'schema_version' is distinct from '3'
    or not p.payroll_register ?& array['bonus','adjustment_incentive','adjustment_deductions','ledger_advance_recovery']
    or exists(select 1 from jsonb_each(p.payroll_register) j where j.key in ('bonus','adjustment_incentive','adjustment_deductions','ledger_advance_recovery')
      and (jsonb_typeof(j.value)<>'number' or (j.value#>>'{}')::numeric<0 or (j.value#>>'{}')::numeric>='Infinity'::numeric))
    or (p.payroll_register->>'bonus')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_adjustments a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period and a.kind='bonus')
    or (p.payroll_register->>'adjustment_incentive')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_adjustments a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period and a.kind='incentive')
    or (p.payroll_register->>'adjustment_deductions')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_adjustments a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period and a.kind='deduction')
    or (p.payroll_register->>'ledger_advance_recovery')::numeric is distinct from
      (select coalesce(sum(a.amount),0) from public.payroll_advance_recoveries a where a.employee_id=p.employee_id and a.entity_id=p.entity_id and a.period=p.period))) then
    raise exception 'Payroll transaction details do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  if _run.employees is distinct from (select count(*) from public.payslips where run_id=_run_id)
    or _run.total_gross is distinct from (select sum(gross) from public.payslips where run_id=_run_id)
    or _run.total_net is distinct from (select sum(net) from public.payslips where run_id=_run_id) then
    raise exception 'Payroll run totals do not reconcile. Regenerate this draft.' using errcode='23514';
  end if;
  if exists(select 1 from public.payslips p cross join lateral app.payroll_attendance_metrics(p.employee_id,
      (p.payroll_register->>'employment_from')::date,(p.payroll_register->>'employment_to')::date) m
      where p.run_id=_run_id and m.pending_recompute_days>0) then
    raise exception 'Attendance changes are awaiting recomputation. Refresh attendance and regenerate payroll before publishing.' using errcode='55000';
  end if;
  -- Lock exactly the employment interval priced in the immutable register.
  update public.attendance a set is_locked=true from public.payslips p where p.run_id=_run_id and p.employee_id=a.employee_id
    and a.work_date between (p.payroll_register->>'employment_from')::date and (p.payroll_register->>'employment_to')::date;
  update public.payslips set status='Published' where run_id=_run_id;
  update public.payroll_runs set status='Published',published_at=now(),needs_recalculation=false where id=_run_id;
  insert into public.payroll_payments(run_id,employee_id,entity_id,zone_id,branch_id,department_id,updated_by)
    select run_id,employee_id,entity_id,zone_id,branch_id,department_id,auth.uid() from public.payslips where run_id=_run_id
    on conflict(run_id,employee_id) do nothing;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id)
    values(auth.uid(),(select email from auth.users where id=auth.uid()),'PUBLISHED:'||_run.period,'payroll_runs',_run_id,_run.entity_id);
end $$;


-- Old draft fingerprints predate these sources; force explicit regeneration and review.
update public.payroll_runs set needs_recalculation=true where status='Draft' and not needs_recalculation
  and exists(select 1 from public.payslips where run_id=payroll_runs.id and coalesce((payroll_register->>'schema_version')::integer,0)<3);
revoke all on function app.lock_payroll_employee(uuid),app.validate_payroll_transaction_amount(numeric,boolean),
  app.tg_payroll_transaction_history(),app.tg_payroll_transaction_source_guard(),app.tg_payroll_advance_immutable(),
  app.tg_payroll_manual_advance_guard(),app.tg_payroll_payment_guard() from public,anon,authenticated,service_role;
revoke all on function public.save_payroll_adjustment(uuid,text,jsonb,uuid,timestamptz),public.delete_payroll_adjustment(uuid,timestamptz),
  public.get_payroll_advance_recoveries(uuid),public.create_payroll_advance(uuid,date,numeric,text,uuid),public.void_payroll_advance(uuid,text,timestamptz),public.save_payroll_advance_recovery(uuid,text,numeric,timestamptz),
  public.set_payroll_payment_status(uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.save_payroll_adjustment(uuid,text,jsonb,uuid,timestamptz),public.delete_payroll_adjustment(uuid,timestamptz),
  public.get_payroll_advance_recoveries(uuid),public.create_payroll_advance(uuid,date,numeric,text,uuid),public.void_payroll_advance(uuid,text,timestamptz),public.save_payroll_advance_recovery(uuid,text,numeric,timestamptz),
  public.set_payroll_payment_status(uuid,uuid,text,text,text,timestamptz) to authenticated;
do $$ declare _table text; begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach _table in array array['payroll_adjustments','payroll_advances','payroll_advance_recoveries','payroll_payments'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=_table) then
        execute format('alter publication supabase_realtime add table public.%I',_table);
      end if;
    end loop;
  end if;
end $$;
commit;
