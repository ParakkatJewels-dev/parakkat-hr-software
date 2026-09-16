-- Request identity and decision state are server-owned, even for direct authenticated writes.
-- Trusted database owners/service jobs retain their migration/import path. API permissions and
-- independent-review rules still apply to every authenticated caller, including super admins.
begin;

alter table public.exits add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.exits alter column created_by set default auth.uid();
alter table public.expenses alter column status set default 'Pending';

-- NOT VALID preserves historical evidence rather than silently rewriting existing claims.
-- PostgreSQL still enforces these constraints on every subsequent insert/update.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.expenses'::regclass and conname='expenses_amount_valid') then
    alter table public.expenses add constraint expenses_amount_valid
      check (amount >= 0 and amount < 'Infinity'::numeric and amount <> 'NaN'::numeric) not valid;
  end if;
end $$;

create or replace function app.tg_request_integrity()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,app as $$
declare _uid uuid := auth.uid(); _me uuid; _filer uuid;
begin
  if exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    return new;
  end if;
  if _uid is null then raise exception 'Sign in to submit or review requests.' using errcode='42501'; end if;
  _me := app.current_employee_id();

  if tg_op='INSERT' then
    if tg_table_name='exits' then
      if new.status is distinct from 'Clearance in Progress' or new.approvals is distinct from
        '{"IT":"Pending","Admin":"Pending","Finance":"Pending","HR":"Pending"}'::jsonb then
        raise exception 'New exits must start with pending clearances.' using errcode='42501';
      end if;
      new.created_by := _uid;
    else
      if new.status is distinct from 'Pending' then
        raise exception 'New requests must start Pending.' using errcode='42501';
      end if;
      new.approver_id := null;
      if tg_table_name='expenses' then new.created_by := _uid;
      else
        new.requested_by := _uid;
        new.decided_at := null; new.decided_by := null; new.decision_note := null;
      end if;
    end if;
    return new;
  end if;

  if row(new.id,new.employee_id,new.entity_id,new.zone_id,new.branch_id,new.department_id,new.created_at)
      is distinct from row(old.id,old.employee_id,old.entity_id,old.zone_id,old.branch_id,old.department_id,old.created_at) then
    raise exception 'Request identity and scope cannot be changed.' using errcode='42501';
  end if;
  if tg_table_name in ('expenses','exits') then
    if new.created_by is distinct from old.created_by then
      raise exception 'The original filer cannot be changed.' using errcode='42501';
    end if;
    _filer := old.created_by;
  else
    if new.requested_by is distinct from old.requested_by then
      raise exception 'The original filer cannot be changed.' using errcode='42501';
    end if;
    _filer := old.requested_by;
  end if;

  if tg_table_name='exits' then
    if new.status is distinct from old.status or new.approvals is distinct from old.approvals then
      raise exception 'Use the exit clearance action to record a decision.' using errcode='42501';
    end if;
    if old.status in ('Cleared','Completed') and row(new.last_day,new.reason) is distinct from row(old.last_day,old.reason) then
      raise exception 'A cleared exit cannot be edited.' using errcode='42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if old.employee_id = _me or _filer = _uid then
      raise exception 'You cannot decide your own request or a request you filed.' using errcode='42501';
    end if;
    if tg_table_name='expenses' then
      if not ((old.status='Pending' and new.status in ('Approved','Rejected'))
           or (old.status='Approved' and new.status='Paid')) then
        raise exception 'Invalid expense status transition.' using errcode='22023';
      end if;
      if not app.has_perm('expense.approve',old.entity_id,old.zone_id,old.branch_id,old.department_id,old.employee_id) then
        raise exception 'You cannot review this expense.' using errcode='42501';
      end if;
      if row(new.amount,new.category,new.expense_date,new.description,new.receipt_url)
          is distinct from row(old.amount,old.category,old.expense_date,old.description,old.receipt_url) then
        raise exception 'Claim details cannot change during a decision.' using errcode='42501';
      end if;
      new.approver_id := case when new.status='Paid' then old.approver_id else _me end;
    else
      if old.status <> 'Pending' or new.status not in ('Approved','Rejected','Cancelled') then
        raise exception 'Invalid regularization status transition.' using errcode='22023';
      end if;
      if not app.has_perm('regularization.approve',old.entity_id,old.zone_id,old.branch_id,old.department_id,old.employee_id) then
        raise exception 'You cannot review this correction.' using errcode='42501';
      end if;
      if row(new.work_date,new.check_in,new.check_out,new.reason)
          is distinct from row(old.work_date,old.check_in,old.check_out,old.reason) then
        raise exception 'Correction details cannot change during a decision.' using errcode='42501';
      end if;
      new.approver_id := _me; new.decided_by := _uid; new.decided_at := clock_timestamp();
    end if;
  else
    if new.approver_id is distinct from old.approver_id then
      raise exception 'Decision metadata is server-owned.' using errcode='42501';
    end if;
    if tg_table_name='expenses' then
      if old.status <> 'Pending' and row(new.amount,new.category,new.expense_date,new.description,new.receipt_url)
          is distinct from row(old.amount,old.category,old.expense_date,old.description,old.receipt_url) then
        raise exception 'A decided claim cannot be edited.' using errcode='42501';
      end if;
    else
      if row(new.decided_by,new.decided_at,new.decision_note) is distinct from row(old.decided_by,old.decided_at,old.decision_note) then
        raise exception 'Decision metadata is server-owned.' using errcode='42501';
      end if;
      if old.status <> 'Pending' and row(new.work_date,new.check_in,new.check_out,new.reason)
          is distinct from row(old.work_date,old.check_in,old.check_out,old.reason) then
        raise exception 'A decided correction cannot be edited.' using errcode='42501';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_request_integrity on public.expenses;
create trigger trg_request_integrity before insert or update on public.expenses
  for each row execute function app.tg_request_integrity();
drop trigger if exists trg_request_integrity on public.attendance_regularizations;
create trigger trg_request_integrity before insert or update on public.attendance_regularizations
  for each row execute function app.tg_request_integrity();
drop trigger if exists trg_request_integrity on public.exits;
create trigger trg_request_integrity before insert or update on public.exits
  for each row execute function app.tg_request_integrity();
revoke all on function app.tg_request_integrity() from public,anon;

-- Row locks avoid losing a different department's concurrent decision. No caller can submit an
-- entire approval map or supply an actor; only this checked path mutates clearance state.
create or replace function public.decide_exit_clearance(p_exit_id uuid,p_department text,p_decision text)
returns public.exits language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _exit public.exits; _approvals jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to review exits.' using errcode='42501'; end if;
  if p_department is null or p_department not in ('IT','Admin','Finance','HR')
     or p_decision is null or p_decision not in ('Approved','Rejected') then
    raise exception 'Choose a valid clearance department and decision.' using errcode='22023';
  end if;
  select * into _exit from public.exits where id=p_exit_id for update;
  if _exit.id is null or not app.has_perm('exit.manage',_exit.entity_id,_exit.zone_id,_exit.branch_id,_exit.department_id,_exit.employee_id) then
    raise exception 'You cannot manage this exit.' using errcode='42501';
  end if;
  if _exit.employee_id=app.current_employee_id() or _exit.created_by=auth.uid() then
    raise exception 'Someone else must clear an exit you own or filed.' using errcode='42501';
  end if;
  if _exit.status not in ('Clearance in Progress','Cleared') then
    raise exception 'This exit is closed and cannot receive clearance decisions.' using errcode='22023';
  end if;
  _approvals := '{"IT":"Pending","Admin":"Pending","Finance":"Pending","HR":"Pending"}'::jsonb || coalesce(_exit.approvals,'{}'::jsonb);
  _approvals := jsonb_set(_approvals,array[p_department],to_jsonb(p_decision));
  update public.exits set approvals=_approvals,
    status=case when _approvals @> '{"IT":"Approved","Admin":"Approved","Finance":"Approved","HR":"Approved"}'::jsonb
      then 'Cleared' else 'Clearance in Progress' end
    where id=p_exit_id returning * into _exit;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id,branch_id)
    select auth.uid(),email,'EXIT_CLEARANCE_' || upper(p_department) || '_' || upper(p_decision),
      'exits',_exit.id,_exit.entity_id,_exit.branch_id from auth.users where id=auth.uid();
  return _exit;
end $$;

create or replace function public.complete_exit(p_exit_id uuid)
returns public.exits language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare _exit public.exits;
begin
  if auth.uid() is null then raise exception 'Sign in to complete exits.' using errcode='42501'; end if;
  select * into _exit from public.exits where id=p_exit_id for update;
  if _exit.id is null or not app.has_perm('exit.manage',_exit.entity_id,_exit.zone_id,_exit.branch_id,_exit.department_id,_exit.employee_id) then
    raise exception 'You cannot manage this exit.' using errcode='42501';
  end if;
  if _exit.employee_id=app.current_employee_id() or _exit.created_by=auth.uid() then
    raise exception 'Someone else must complete an exit you own or filed.' using errcode='42501';
  end if;
  if _exit.status is distinct from 'Cleared' or not coalesce(_exit.approvals @>
     '{"IT":"Approved","Admin":"Approved","Finance":"Approved","HR":"Approved"}'::jsonb,false) then
    raise exception 'Every department must approve before completing an exit.' using errcode='22023';
  end if;
  update public.exits set status='Completed' where id=p_exit_id returning * into _exit;
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id,branch_id)
    select auth.uid(),email,'EXIT_COMPLETED','exits',_exit.id,_exit.entity_id,_exit.branch_id from auth.users where id=auth.uid();
  return _exit;
end $$;

revoke all on function public.decide_exit_clearance(uuid,text,text),public.complete_exit(uuid) from public,anon;
grant execute on function public.decide_exit_clearance(uuid,text,text),public.complete_exit(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
