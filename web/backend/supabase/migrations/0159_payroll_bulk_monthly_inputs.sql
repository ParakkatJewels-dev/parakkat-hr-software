-- Grid, paste and spreadsheet imports use one transaction and the same employee-level
-- authorization, revision checks, approval notes and publication guards as a single edit.
begin;

create or replace function public.save_payroll_monthly_inputs(_entity_id uuid,_period text,_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare
  _entry record; _employee public.employees%rowtype; _employee_id uuid;
  _expected timestamptz; _seen uuid[]:='{}'::uuid[]; _saved jsonb:='[]'::jsonb;
  _context text; _state text; _message text;
begin
  if auth.uid() is null or not app.has_perm_any_scope('payroll.manage') then
    raise exception 'Not authorized to save payroll inputs.' using errcode='42501';
  end if;
  perform app.payroll_period_start(_period);
  if _entity_id is null then raise exception 'Choose a payroll company.' using errcode='22023'; end if;
  if jsonb_typeof(_rows) is distinct from 'array' then
    raise exception 'Payroll inputs must be an array of employee rows.' using errcode='22023';
  end if;
  if jsonb_array_length(_rows)<1 or jsonb_array_length(_rows)>1000 then
    raise exception 'Save between 1 and 1000 employee rows at a time.' using errcode='22023';
  end if;
  perform app.lock_payroll(_entity_id);

  for _entry in select value,ordinality from jsonb_array_elements(_rows) with ordinality loop
    _context:='Row '||_entry.ordinality;
    begin
      if jsonb_typeof(_entry.value) is distinct from 'object' then
        raise exception 'Each payroll row must be an object.' using errcode='22023';
      end if;
      if exists(select 1 from jsonb_object_keys(_entry.value) k
          where k not in ('employee_id','input','expected_updated_at'))
        or jsonb_typeof(_entry.value->'employee_id') is distinct from 'string'
        or jsonb_typeof(_entry.value->'input') is distinct from 'object'
        or coalesce(jsonb_typeof(_entry.value->'expected_updated_at'),'null') not in ('string','null') then
        raise exception 'Use employee_id, an input object and the saved expected_updated_at revision.' using errcode='22023';
      end if;
      begin
        _employee_id:=(_entry.value->>'employee_id')::uuid;
        _expected:=(_entry.value->>'expected_updated_at')::timestamptz;
      exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
        raise exception 'The employee ID or saved revision is invalid. Reload the worksheet.' using errcode='22023';
      end;
      if _employee_id=any(_seen) then
        raise exception 'An employee appears more than once. Combine duplicate rows before saving.' using errcode='22023';
      end if;
      _seen:=array_append(_seen,_employee_id);
      select * into _employee from public.employees where id=_employee_id and entity_id=_entity_id;
      if _employee.id is null or not app.has_perm('payroll.manage',_employee.entity_id,_employee.zone_id,
          _employee.branch_id,_employee.department_id,_employee.id) then
        raise exception 'Employee is not available in your payroll scope for the selected company.' using errcode='42501';
      end if;
      _context:=_context||' ('||coalesce(nullif(_employee.employee_code,''),_employee.id::text)||' — '||_employee.full_name||')';
      _saved:=_saved||jsonb_build_array(public.save_payroll_monthly_input(
        _employee_id,_period,_entry.value->'input',_expected));
    exception when others then
      get stacked diagnostics _state=returned_sqlstate,_message=message_text;
      -- Re-raise, preserving the actionable concurrency/permission/validation code. The whole
      -- RPC statement rolls back, including earlier rows, stale flags and audit events.
      raise exception using errcode=_state,message=_context||': '||_message;
    end;
  end loop;
  return _saved;
end $$;

revoke all on function public.save_payroll_monthly_inputs(uuid,text,jsonb) from public,anon;
grant execute on function public.save_payroll_monthly_inputs(uuid,text,jsonb) to authenticated,service_role;

commit;
