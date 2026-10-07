-- HR endpoint corrections live only in Supabase. They reuse the attendance engine's
-- approved overlays; neither original device punches nor EasyTime Pro are modified.
begin;

create table if not exists public.attendance_punch_correction_history (
  request_id uuid primary key,
  employee_id uuid not null references public.employees(id),
  work_date date not null,
  entity_id uuid not null references public.entities(id),
  zone_id uuid, branch_id uuid, department_id uuid,
  correction_id uuid not null references public.attendance_regularizations(id),
  previous_correction_id uuid references public.attendance_regularizations(id),
  payload jsonb not null,
  source_revision text not null,
  before_state jsonb not null,
  after_state jsonb not null,
  reason text not null,
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp()
);
create index if not exists attendance_punch_history_day_idx
  on public.attendance_punch_correction_history(employee_id,work_date,changed_at desc);
alter table public.attendance_punch_correction_history enable row level security;
drop policy if exists punch_history_select on public.attendance_punch_correction_history;
create policy punch_history_select on public.attendance_punch_correction_history for select to authenticated
  using(app.has_perm('attendance.read',entity_id,zone_id,branch_id,department_id,employee_id));
drop policy if exists active_account_required on public.attendance_punch_correction_history;
create policy active_account_required on public.attendance_punch_correction_history as restrictive for all to authenticated
  using(app.session_is_active()) with check(app.session_is_active());
create or replace function app.tg_punch_correction_history_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'Punch correction history is immutable.' using errcode='55000'; end $$;
drop trigger if exists punch_correction_history_immutable on public.attendance_punch_correction_history;
create trigger punch_correction_history_immutable before update or delete on public.attendance_punch_correction_history
  for each row execute function app.tg_punch_correction_history_immutable();
revoke all on public.attendance_punch_correction_history from public,anon,authenticated,service_role;
grant select on public.attendance_punch_correction_history to authenticated,service_role;

-- One snapshot supplies both the editor and its revision. The surrounding dates cover
-- overnight shift windows. Only normalized punch evidence is exposed, never device payloads.
create or replace function app.attendance_punch_correction_source(_employee_id uuid,_work_date date)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,app as $$
  select jsonb_build_object(
    'employee',jsonb_build_object('id',e.id,'entity_id',e.entity_id,'zone_id',e.zone_id,
      'branch_id',e.branch_id,'department_id',e.department_id,'join_date',e.join_date),
    'attendance',(select to_jsonb(a) from public.attendance a where a.employee_id=e.id and a.work_date=_work_date),
    'active_correction',(select to_jsonb(r) from public.attendance_regularizations r
      where r.employee_id=e.id and r.work_date=_work_date and r.status in ('Pending','Approved')),
    'raw_punches',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'punch_time',p.punch_time,
      'punch_state',p.punch_state,'punch_state_label',p.punch_state_label,'source',p.source)
      order by p.punch_time,p.id) from public.raw_punches p where p.employee_id=e.id
      and p.punch_time>=((_work_date-1)::timestamp at time zone 'Asia/Kolkata')
      and p.punch_time<((_work_date+2)::timestamp at time zone 'Asia/Kolkata')),'[]'::jsonb),
    'queue',coalesce((select jsonb_agg(to_jsonb(q) order by q.id) from public.attendance_recompute_queue q
      where (q.employee_id=e.id or q.employee_id is null) and q.work_date=_work_date),'[]'::jsonb),
    'published',exists(select 1 from public.payslips p where p.employee_id=e.id
      and p.period=to_char(_work_date,'YYYY-MM') and p.status='Published')
  ) from public.employees e where e.id=_employee_id;
$$;

create or replace function public.get_attendance_punch_correction_context(_employee_id uuid,_work_date date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare _emp public.employees; _source jsonb; _locked boolean; _blocked text; _active jsonb;
begin
  select * into _emp from public.employees where id=_employee_id;
  if auth.uid() is null or _emp.id is null or not app.has_perm('attendance.read',_emp.entity_id,
    _emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to view this attendance day.' using errcode='42501';
  end if;
  if _work_date is null or not isfinite(_work_date) then
    raise exception 'Choose a valid work date.' using errcode='22023';
  end if;
  _source:=app.attendance_punch_correction_source(_employee_id,_work_date);
  _active:=_source->'active_correction';
  _locked:=coalesce((_source#>>'{attendance,is_locked}')::boolean,false) or (_source->>'published')::boolean;
  _blocked:=case
    when not app.has_perm('attendance.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id)
      then 'You do not have permission to correct this employee’s punches.'
    when _emp.id=app.current_employee_id() or _emp.user_id=auth.uid()
      then 'Another HR manager must correct your own attendance.'
    when _locked then 'This attendance day is locked by finalized payroll.'
    when _work_date>(now() at time zone 'Asia/Kolkata')::date then 'Future attendance cannot be corrected.'
    when _emp.join_date is not null and _work_date<_emp.join_date then 'This date is before the employee joined.'
    when _active->>'status'='Pending' then 'Review the pending correction request before editing this day.'
    else null end;
  return jsonb_build_object('employee_id',_employee_id,'work_date',_work_date,
    'source_revision',md5(_source::text),'attendance',_source->'attendance',
    'active_correction',_active,'raw_punches',_source->'raw_punches',
    'check_in',case when _active->>'status'='Approved' then coalesce(_active->>'check_in',_source#>>'{attendance,check_in}')
      else _source#>>'{attendance,check_in}' end,
    'check_out',case when _active->>'status'='Approved' then coalesce(_active->>'check_out',_source#>>'{attendance,check_out}')
      else _source#>>'{attendance,check_out}' end,
    'is_locked',_locked,'can_correct',_blocked is null,'blocked_reason',_blocked,
    'pending_recompute',exists(select 1 from jsonb_array_elements(_source->'queue') q where q->>'processed_at' is null),
    'history',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id)
      from public.attendance_regularizations r where r.employee_id=_employee_id and r.work_date=_work_date),'[]'::jsonb),
    'correction_history',coalesce((select jsonb_agg(to_jsonb(h)-'payload' order by h.changed_at desc,h.request_id)
      from public.attendance_punch_correction_history h where h.employee_id=_employee_id and h.work_date=_work_date),'[]'::jsonb));
end $$;

create or replace function public.save_attendance_punch_correction(
  _request_id uuid,_employee_id uuid,_work_date date,_check_in timestamptz,_check_out timestamptz,
  _reason text,_source_revision text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _emp public.employees; _entity uuid; _actor uuid:=auth.uid(); _source jsonb; _payload jsonb;
  _prior public.attendance_regularizations; _saved public.attendance_regularizations;
  _receipt public.attendance_punch_correction_history; _trimmed text:=btrim(coalesce(_reason,''));
begin
  select * into _emp from public.employees where id=_employee_id;
  if _actor is null or _emp.id is null or not app.has_perm('attendance.manage',_emp.entity_id,
    _emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id) then
    raise exception 'Not authorized to correct this employee’s punches.' using errcode='42501';
  end if;
  if _emp.id=app.current_employee_id() or _emp.user_id=_actor then
    raise exception 'Another HR manager must correct your own attendance.' using errcode='42501';
  end if;
  if _request_id is null or _work_date is null or not isfinite(_work_date) then
    raise exception 'A request ID and valid work date are required.' using errcode='22023';
  end if;
  if length(_trimmed)<3 or length(_trimmed)>1000 then
    raise exception 'Enter a correction reason between 3 and 1000 characters.' using errcode='22023';
  end if;
  if _check_in is null and _check_out is null then
    raise exception 'Enter a check-in or check-out time.' using errcode='22023';
  end if;
  if (_check_in is not null and (not isfinite(_check_in) or (_check_in at time zone 'Asia/Kolkata')::date<>_work_date))
    or (_check_out is not null and (not isfinite(_check_out) or (_check_out at time zone 'Asia/Kolkata')::date not in (_work_date,_work_date+1)))
    or (_check_in is not null and _check_out is not null and _check_out<=_check_in) then
    raise exception 'Check-in must be on the work date; check-out must follow it on the same or next day.' using errcode='22023';
  end if;
  if _work_date>(now() at time zone 'Asia/Kolkata')::date or _check_in>clock_timestamp() or _check_out>clock_timestamp() then
    raise exception 'Future punches cannot be recorded.' using errcode='22023';
  end if;
  if _emp.join_date is not null and _work_date<_emp.join_date then
    raise exception 'This date is before the employee joined.' using errcode='22023';
  end if;
  _payload:=jsonb_build_object('employee_id',_employee_id,'work_date',_work_date,
    'check_in',_check_in,'check_out',_check_out,'reason',_trimmed,'source_revision',_source_revision);
  -- Same order as publication and all payroll source changes. Recheck scope after waiting.
  _entity:=_emp.entity_id; perform app.lock_payroll(_entity);
  select * into _emp from public.employees where id=_employee_id;
  if _emp.entity_id is distinct from _entity then
    raise exception 'Employee company changed. Reload before saving.' using errcode='40001';
  end if;
  if not app.has_perm('attendance.manage',_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,_emp.id)
    or _emp.id=app.current_employee_id() or _emp.user_id=_actor then
    raise exception 'Not authorized to correct this employee’s punches.' using errcode='42501';
  end if;
  -- Serialize request keys even when two accidental uses target different companies.
  perform pg_advisory_xact_lock(hashtextextended('attendance-punch-request:'||_request_id::text,0));
  select * into _receipt from public.attendance_punch_correction_history where request_id=_request_id;
  if _receipt.request_id is not null then
    if _receipt.changed_by is distinct from _actor or _receipt.payload is distinct from _payload then
      raise exception 'This correction request ID was already used. Reload before saving.' using errcode='40001';
    end if;
    return jsonb_build_object('correction_id',_receipt.correction_id,'employee_id',_employee_id,
      'work_date',_work_date,'recompute_pending',exists(select 1 from public.attendance_recompute_queue q
        where (q.employee_id=_employee_id or q.employee_id is null) and q.work_date=_work_date and q.processed_at is null),
      'already_saved',true);
  end if;
  _source:=app.attendance_punch_correction_source(_employee_id,_work_date);
  if coalesce((_source#>>'{attendance,is_locked}')::boolean,false) or (_source->>'published')::boolean then
    raise exception 'This attendance day is locked by finalized payroll.' using errcode='55000';
  end if;
  if _source#>>'{active_correction,status}'='Pending' then
    raise exception 'Review the pending correction request before editing this day.' using errcode='55000';
  end if;
  if _source_revision is null or md5(_source::text) is distinct from _source_revision then
    raise exception 'This attendance day changed. Reload the latest punches before saving.' using errcode='40001';
  end if;
  select * into _prior from public.attendance_regularizations
    where employee_id=_employee_id and work_date=_work_date and status='Approved';
  if _prior.id is not null then
    -- Preserve the original requester, reviewer, times and reason as historical evidence.
    update public.attendance_regularizations set status='Cancelled' where id=_prior.id;
  end if;
  insert into public.attendance_regularizations(id,employee_id,work_date,check_in,check_out,reason,
    status,requested_by,approver_id,decided_by,decided_at,decision_note)
  values(_request_id,_employee_id,_work_date,_check_in,_check_out,_trimmed,'Approved',
    _actor,app.current_employee_id(),_actor,clock_timestamp(),'Direct HR punch correction in Supabase')
  returning * into _saved;
  insert into public.attendance_punch_correction_history(request_id,employee_id,work_date,entity_id,zone_id,branch_id,
    department_id,correction_id,previous_correction_id,payload,source_revision,before_state,after_state,reason,changed_by)
  values(_request_id,_employee_id,_work_date,_emp.entity_id,_emp.zone_id,_emp.branch_id,_emp.department_id,
    _saved.id,_prior.id,_payload,_source_revision,_source,to_jsonb(_saved),_trimmed,_actor);
  insert into public.audit_log(actor,actor_email,action,table_name,row_id,entity_id,branch_id)
    select _actor,email,'ATTENDANCE_PUNCH_CORRECTED','attendance_regularizations',_saved.id,_emp.entity_id,_emp.branch_id
      from auth.users where id=_actor;
  return jsonb_build_object('correction_id',_saved.id,'employee_id',_employee_id,
    'work_date',_work_date,'recompute_pending',true,'already_saved',false);
end $$;

revoke all on function app.attendance_punch_correction_source(uuid,date),app.tg_punch_correction_history_immutable()
  from public,anon,authenticated,service_role;
revoke all on function public.get_attendance_punch_correction_context(uuid,date),
  public.save_attendance_punch_correction(uuid,uuid,date,timestamptz,timestamptz,text,text) from public,anon;
grant execute on function public.get_attendance_punch_correction_context(uuid,date),
  public.save_attendance_punch_correction(uuid,uuid,date,timestamptz,timestamptz,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
