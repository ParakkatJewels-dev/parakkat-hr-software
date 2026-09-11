\set ON_ERROR_STOP on
-- Independent expected scope boundaries: five peers differ at department, branch, zone and
-- company; the sixth row belongs to the caller. Every mutation is rolled back independently.
create table audit_test.results(label text primary key, actual jsonb, expected jsonb);
grant select,insert on audit_test.results to authenticated,anon;
create function audit_test.expect(_label text, _actual jsonb, _expected jsonb) returns void
language plpgsql as $$ begin
  if _actual is distinct from _expected then
    raise exception 'FAIL %: expected %, got %',_label,_expected,_actual;
  end if;
  insert into audit_test.results values (_label,_actual,_expected);
end $$;
create function audit_test.write_expect(_label text,_sql text,_allowed boolean,_value jsonb,_returning boolean default true) returns void
language plpgsql as $$
declare _actual jsonb; _state text; _message text; _count integer;
begin
  begin
    if _returning then execute _sql into _actual;
    else execute _sql; get diagnostics _count=row_count; _actual:=case when _count=0 then '[]'::jsonb else jsonb_build_array(_count) end; end if;
    raise exception using errcode='PZ001',message='Rollback successful test mutation';
  exception
    when sqlstate 'PZ001' then null;
    when insufficient_privilege then _actual := '[]'::jsonb;
    when raise_exception then
      get stacked diagnostics _state=returned_sqlstate,_message=message_text;
      if _message <> 'not authorized to grant this role at this scope'
         and _message not like '% cannot be granted at % scope' then raise; end if;
      _actual := '[]'::jsonb;
  end;
  perform audit_test.expect(_label,_actual,case when _allowed then _value else '[]'::jsonb end);
end $$;
create function audit_test.grant_then_revoke(_user uuid) returns jsonb language plpgsql as $$
declare _id uuid:=gen_random_uuid(); _actual jsonb;
begin
  insert into public.role_assignments(id,user_id,role_id,scope_type)
    select _id,_user,id,'self' from public.roles where key='employee';
  with removed as (delete from public.role_assignments where id=_id returning scope_type)
    select coalesce(jsonb_agg(scope_type),'[]'::jsonb) into _actual from removed;
  return _actual;
end $$;
-- Test-only observation permits checking FK side effects on a row the actor cannot read.
create function audit_test.task_parent(_task uuid) returns uuid language sql security definer as $$
  select parent_task_id from public.tasks where id=_task
$$;
create function audit_test.delete_parent_and_check_child() returns jsonb language plpgsql as $$
declare n integer;
begin
  delete from public.tasks where id=audit_test.id(5,1);
  get diagnostics n=row_count;
  return jsonb_build_array(jsonb_build_object('deleted',n,'childParent',audit_test.task_parent(audit_test.id(5,5))));
end $$;
create function audit_test.create_then_delete_own_task() returns jsonb language plpgsql as $$
declare _id uuid:=gen_random_uuid(); n integer;
begin
  insert into public.tasks(id,employee_id,assigned_by,title)
    values(_id,app.current_employee_id(),app.current_employee_id(),'Personal task');
  delete from public.tasks where id=_id;
  get diagnostics n=row_count;
  return jsonb_build_array(n);
end $$;
create function audit_test.accept_help_request() returns jsonb language plpgsql as $$
declare _task uuid; _actual jsonb;
begin
  _task:=public.respond_to_help_request(audit_test.id(8,1),true,audit_test.id(5,2),null,'High');
  select jsonb_build_array(jsonb_build_object('assigned_by',assigned_by,'employee_id',employee_id,'priority',priority))
    into _actual from public.tasks where id=_task;
  return _actual;
end $$;
grant execute on all functions in schema audit_test to authenticated,anon;

set role authenticated;
do $$
declare a record; t integer; e uuid; module text; actual jsonb; expected jsonb; own boolean; in_scope boolean;
  can_manage boolean; prefix text; field text; value text; json_value jsonb;
begin
  for a in select * from audit_test.actors order by ordinal loop
    perform set_config('request.jwt.claim.sub',a.user_id::text,true);
    prefix := a.key || '/';
    perform audit_test.expect(prefix||'authenticated employee identity', public.get_my_access()->'employee'->'id',to_jsonb(a.employee_id::text));
    perform audit_test.expect(prefix||'superadmin flag',public.get_my_access()->'is_super_admin',to_jsonb(a.key='super_admin'));
    select coalesce(jsonb_agg((u->>'employee_id') order by u->>'employee_id'),'[]'::jsonb) into actual
      from jsonb_array_elements(public.list_managed_users()) u
      where (u->>'employee_id')::uuid between audit_test.id(5,1) and audit_test.id(5,5)
        or (u->>'employee_id')::uuid=a.employee_id;
    select coalesce(jsonb_agg(eid::text order by eid),'[]'::jsonb) into expected from (
      select audit_test.id(5,n) eid from generate_series(1,5)n where n<=a.visible_targets
      union all select a.employee_id where a.ordinal<=6
    )s;
    perform audit_test.expect(prefix||'role administration/exact managed users',actual,expected);
    foreach module in array array['employees','attendance','leaves','expenses','tasks','goals','payslips'] loop
      select coalesce(jsonb_agg(eid::text order by eid),'[]'::jsonb) into expected from (
        select audit_test.id(5,n) eid from generate_series(1,5)n
        where n <= case when module='payslips' and a.ordinal>3 then 0 else a.visible_targets end
        union all select a.employee_id where a.key <> 'unassigned'
      ) s;
      execute format('select coalesce(jsonb_agg(id::text order by id),''[]''::jsonb) from public.%I
        where (id between %L::uuid and %L::uuid or id=%L) %s',module,audit_test.id(5,1),audit_test.id(5,5),a.employee_id,
        case when module='payslips' then 'and status=''Published''' else '' end) into actual;
      perform audit_test.expect(prefix||module||'/exact visible rows',actual,expected);
    end loop;
    select coalesce(jsonb_agg(eid::text order by eid),'[]'::jsonb) into expected from (
      select audit_test.id(5,n) eid from generate_series(1,5)n where n<=a.visible_targets and a.ordinal<=3
      union all select a.employee_id where a.ordinal<=3
    )s;
    select coalesce(jsonb_agg(employee_id::text order by employee_id),'[]'::jsonb) into actual from public.payslips
      where status='Draft' and (employee_id between audit_test.id(5,1) and audit_test.id(5,5) or employee_id=a.employee_id);
    perform audit_test.expect(prefix||'payslips/drafts',actual,expected);

    for t in 1..6 loop
      own := t=6;
      e := case when own then a.employee_id else audit_test.id(5,t) end;
      in_scope := a.key<>'unassigned' and (own or t<=a.visible_targets);
      prefix := a.key||'/'||case when own then 'self' else 'target'||t end||'/';
      foreach module in array array['employees','attendance','leaves','expenses','tasks','goals','payslips'] loop
        can_manage := in_scope and case module
          when 'employees' then a.ordinal<=6
          when 'attendance' then a.ordinal<=5
          when 'leaves' then a.ordinal<=6 and (not own or a.ordinal=1)
          when 'expenses' then a.ordinal<=5 and (not own or a.ordinal=1)
          when 'tasks' then true
          when 'goals' then true
          when 'payslips' then a.ordinal<=3 end;
        field := case module when 'employees' then 'phone' when 'attendance' then 'hours'
          when 'goals' then 'progress' when 'payslips' then 'net' else 'status' end;
        value := case module when 'employees' then quote_literal('5550100') when 'attendance' then '7'
          when 'goals' then '25' when 'payslips' then '800' when 'tasks' then quote_literal('In Progress') else quote_literal('Rejected') end;
        json_value := case module when 'employees' then '["5550100"]' when 'attendance' then '[7]'
          when 'goals' then '[25]' when 'payslips' then '[800]' when 'tasks' then '["In Progress"]' else '["Rejected"]' end;
        perform audit_test.write_expect(prefix||module||'/update',format(
          'with changed as (update public.%I set %I=%s where id=%L returning %I) select coalesce(jsonb_agg(%I),''[]''::jsonb) from changed',
          module,field,value,e,field,field),can_manage,json_value);
      end loop;
      perform audit_test.write_expect(prefix||'goals/definition',format(
        'with changed as (update public.goals set title=''Changed goal'' where id=%L returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',e),
        in_scope and a.ordinal<=6,'["Changed goal"]');
      perform audit_test.write_expect(prefix||'goals/delete',format(
        'with changed as (delete from public.goals where id=%L returning id) select coalesce(jsonb_agg(id::text),''[]''::jsonb) from changed',e),
        in_scope and a.ordinal<=6,jsonb_build_array(e::text));
      perform audit_test.write_expect(prefix||'tasks/delegated delete',format(
        'with changed as (delete from public.tasks where id=%L returning id) select coalesce(jsonb_agg(id::text),''[]''::jsonb) from changed',e),
        in_scope and a.ordinal<=6,jsonb_build_array(e::text));
      perform audit_test.write_expect(prefix||'tasks/delegator identity',format(
        'with changed as (update public.tasks set assigned_by=%L where id=%L returning assigned_by) select coalesce(jsonb_agg(assigned_by::text),''[]''::jsonb) from changed',a.employee_id,e),
        in_scope and a.ordinal<=6,jsonb_build_array(a.employee_id::text));
      perform audit_test.write_expect(prefix||'attendance/insert',format(
        'with changed as (insert into public.attendance(employee_id,work_date,hours) values (%L,''2026-09-03'',8) returning hours) select coalesce(jsonb_agg(hours),''[]''::jsonb) from changed',e),
        in_scope and a.ordinal<=5,'[8]');
      perform audit_test.write_expect(prefix||'leaves/insert',format(
        'with changed as (insert into public.leaves(employee_id,type,start_date,end_date,days) values (%L,''Casual Leave'',''2026-09-04'',''2026-09-04'',1) returning days) select coalesce(jsonb_agg(days),''[]''::jsonb) from changed',e),
        in_scope,'[1]');
      perform audit_test.write_expect(prefix||'expenses/insert',format(
        'with changed as (insert into public.expenses(employee_id,amount,status) values (%L,200,''Pending'') returning amount) select coalesce(jsonb_agg(amount),''[]''::jsonb) from changed',e),
        in_scope,'[200]');
      perform audit_test.write_expect(prefix||'tasks/insert',format(
        'with changed as (insert into public.tasks(employee_id,title,assigned_by) values (%L,''Own task'',%L) returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',e,a.employee_id),
        in_scope,'["Own task"]');
      perform audit_test.write_expect(prefix||'goals/insert',format(
        'with changed as (insert into public.goals(employee_id,title) values (%L,''New goal'') returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',e),
        in_scope and a.ordinal<=6,'["New goal"]');
      if not own then
        perform audit_test.write_expect(prefix||'role administration/employee grant',format(
          'insert into public.role_assignments(user_id,role_id,scope_type) select %L,id,''self'' from public.roles where key=''employee''',audit_test.id(7,t)),
          t<=a.visible_targets and a.ordinal<=6,'[1]',false);
        perform audit_test.write_expect(prefix||'role administration/revoke with returned row',format(
          'select audit_test.grant_then_revoke(%L)',audit_test.id(7,t)),
          t<=a.visible_targets and a.ordinal<=6,'["self"]');
      end if;
    end loop;
    prefix:=a.key||'/';
    perform audit_test.write_expect(prefix||'role administration/superadmin grant',format(
      'insert into public.role_assignments(user_id,role_id,scope_type) select %L,id,''global'' from public.roles where key=''super_admin''',audit_test.id(7,1)),
      a.ordinal=1,'[1]',false);
    perform audit_test.write_expect(prefix||'role administration/branch manager grant',format(
      'insert into public.role_assignments(user_id,role_id,scope_type,scope_id) select %L,id,''branch'',%L from public.roles where key=''branch_manager''',audit_test.id(7,1),audit_test.id(3,1)),
      a.ordinal in(1,2,4),'[1]',false);
    perform audit_test.write_expect(prefix||'role administration/invalid built-in scope',format(
      'insert into public.role_assignments(user_id,role_id,scope_type,scope_id) select %L,id,''entity'',%L from public.roles where key=''branch_manager''',audit_test.id(7,1),audit_test.id(1,1)),
      false,'[]',false);
  end loop;
end $$;
reset role;

insert into public.help_requests(id,entity_id,from_department_id,from_branch_id,to_department_id,to_branch_id,requested_by,title)
  values(audit_test.id(8,1),audit_test.id(1,1),audit_test.id(4,1),audit_test.id(3,1),audit_test.id(4,2),audit_test.id(3,1),audit_test.id(5,106),'Actual help-request workflow');
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub',audit_test.id(6,5)::text,true);
  perform audit_test.write_expect('branch_manager/task ancestry/accepted help request keeps requester attribution',
    'select audit_test.accept_help_request()',true,jsonb_build_array(jsonb_build_object('assigned_by',audit_test.id(5,106),'employee_id',audit_test.id(5,2),'priority','High')));
  perform audit_test.write_expect('branch_manager/task ancestry/cannot attach foreign parent',
    'with changed as (update public.tasks set parent_task_id=audit_test.id(5,5) where id=audit_test.id(5,1) returning parent_task_id) select coalesce(jsonb_agg(parent_task_id),''[]''::jsonb) from changed',false,'[]');
  perform audit_test.write_expect('branch_manager/task ancestry/cannot insert under foreign parent',
    'with changed as (insert into public.tasks(employee_id,title,assigned_by,parent_task_id) values(audit_test.id(5,1),''Foreign parent'',audit_test.id(5,105),audit_test.id(5,5)) returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',false,'[]');
  perform audit_test.write_expect('branch_manager/task ancestry/can insert under managed parent',
    'with changed as (insert into public.tasks(employee_id,title,assigned_by,parent_task_id) values(audit_test.id(5,2),''Managed parent'',audit_test.id(5,105),audit_test.id(5,1)) returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',true,'["Managed parent"]');
  perform audit_test.write_expect('branch_manager/task ancestry/can reparent within scope',
    'with changed as (update public.tasks set parent_task_id=audit_test.id(5,1) where id=audit_test.id(5,2) returning parent_task_id) select coalesce(jsonb_agg(parent_task_id::text),''[]''::jsonb) from changed',true,jsonb_build_array(audit_test.id(5,1)::text));
  perform audit_test.write_expect('branch_manager/task ancestry/forged entity restored canonically',
    'with changed as (update public.tasks set entity_id=audit_test.id(1,2) where id=audit_test.id(5,2) returning entity_id) select coalesce(jsonb_agg(entity_id::text),''[]''::jsonb) from changed',true,jsonb_build_array(audit_test.id(1,1)::text));
  perform audit_test.write_expect('branch_manager/task ancestry/reassign within managed scope',
    'with changed as (update public.tasks set employee_id=audit_test.id(5,2) where id=audit_test.id(5,1) returning employee_id) select coalesce(jsonb_agg(employee_id::text),''[]''::jsonb) from changed',true,jsonb_build_array(audit_test.id(5,2)::text));
  perform set_config('request.jwt.claim.sub',audit_test.id(6,7)::text,true);
  perform audit_test.write_expect('employee/personal task/cannot impersonate manager at creation',
    'with changed as (insert into public.tasks(employee_id,title,assigned_by) values(audit_test.id(5,107),''Forged author'',audit_test.id(5,105)) returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',false,'[]');
  perform audit_test.write_expect('employee/personal task/can create and delete own root',
    'select audit_test.create_then_delete_own_task()',true,'[1]');
end $$;
reset role;
-- A historical cross-scope child must not strand an otherwise authorized parent deletion.
update public.tasks set parent_task_id=audit_test.id(5,1) where id=audit_test.id(5,5);
set role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub',audit_test.id(6,5)::text,true);
  perform audit_test.write_expect('branch_manager/task ancestry/FK cleanup after parent deletion',
    'select audit_test.delete_parent_and_check_child()',true,'[{"deleted":1,"childParent":null}]');
end $$;
reset role;

-- Shared work intentionally crosses the normal reporting hierarchy. Membership may progress the
-- work, but cannot replace its delegator or move its primary assignment into another scope.
insert into public.task_assignees(task_id,employee_id)
  values (audit_test.id(5,5),audit_test.id(5,107)),(audit_test.id(5,5),audit_test.id(5,104));
set role authenticated;
do $$ declare actor_number integer; actor_id uuid; actual jsonb; begin
  foreach actor_number in array array[4,7] loop
    actor_id:=audit_test.id(6,actor_number);
    perform set_config('request.jwt.claim.sub',actor_id::text,true);
    select jsonb_agg(title) into actual from public.tasks where id=audit_test.id(5,5);
    perform audit_test.expect('shared/'||actor_number||'/read explicitly assigned foreign task',actual,'["Role audit"]');
    perform audit_test.write_expect('shared/'||actor_number||'/progress',
      'with changed as (update public.tasks set status=''Done'' where id=audit_test.id(5,5) returning status) select coalesce(jsonb_agg(status),''[]''::jsonb) from changed',true,'["Done"]');
    perform audit_test.write_expect('shared/'||actor_number||'/edit details',
      'with changed as (update public.tasks set title=''Clarified work'' where id=audit_test.id(5,5) returning title) select coalesce(jsonb_agg(title),''[]''::jsonb) from changed',true,'["Clarified work"]');
    perform audit_test.write_expect('shared/'||actor_number||'/cannot move foreign task into own scope',format(
      'with changed as (update public.tasks set employee_id=%L where id=audit_test.id(5,5) returning employee_id) select coalesce(jsonb_agg(employee_id),''[]''::jsonb) from changed',audit_test.id(5,100+actor_number)),false,'[]');
    perform audit_test.write_expect('shared/'||actor_number||'/cannot forge delegator',format(
      'with changed as (update public.tasks set assigned_by=%L where id=audit_test.id(5,5) returning assigned_by) select coalesce(jsonb_agg(assigned_by),''[]''::jsonb) from changed',audit_test.id(5,100+actor_number)),false,'[]');
    perform audit_test.write_expect('shared/'||actor_number||'/cannot move parent',
      'with changed as (update public.tasks set parent_task_id=audit_test.id(5,2) where id=audit_test.id(5,5) returning parent_task_id) select coalesce(jsonb_agg(parent_task_id),''[]''::jsonb) from changed',false,'[]');
  end loop;
  -- 0113 explicitly permits any linked login to jot a personal root task, even without an ESS
  -- grant. Such an unassigned login still cannot read or update it. Test that exception openly.
  perform set_config('request.jwt.claim.sub',audit_test.id(6,8)::text,true);
  perform audit_test.write_expect('unassigned/personal task/insert without representation',
    'insert into public.tasks(employee_id,title,assigned_by) values(audit_test.id(5,108),''Personal note'',audit_test.id(5,108))',true,'[1]',false);
end $$;
reset role;

set role anon;
do $$ declare module text; count_rows integer; begin
  perform set_config('request.jwt.claim.sub','',true);
  foreach module in array array['employees','attendance','leaves','expenses','tasks','goals','payslips','role_assignments'] loop
    execute format('select count(*) from public.%I',module) into count_rows;
    perform audit_test.expect('anonymous/'||module||'/RLS returns zero rows',to_jsonb(count_rows),'0');
  end loop;
  perform audit_test.expect('anonymous/access RPC reveals no employee',public.get_my_access()->'employee','null');
  perform audit_test.expect('anonymous/access RPC grants no permissions',public.get_my_access()->'permissions','[]');
  perform audit_test.expect('anonymous/access RPC grants no assignments',public.get_my_access()->'assignments','[]');
  perform audit_test.expect('anonymous/access RPC superadmin denied',public.get_my_access()->'is_super_admin','false');
end $$;
reset role;
select 'PASS: '||count(*)||' real PostgreSQL role assertions across all seven standard roles, unassigned and anonymous' from audit_test.results;
