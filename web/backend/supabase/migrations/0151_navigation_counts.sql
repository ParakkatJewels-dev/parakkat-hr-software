-- Every actionable navigation destination shares one current, caller-scoped summary. Keep the
-- original five-key RPC intact for older clients while adding nested queues to the new contract.
begin;

create index if not exists payroll_runs_draft_count_idx on public.payroll_runs(entity_id) where status='Draft';
create index if not exists candidates_active_count_idx on public.candidates(entity_id,branch_id,department_id)
  where stage in ('Applied','Shortlisted','Interview','Offered');
create index if not exists onboarding_incomplete_count_idx on public.onboarding(entity_id,branch_id,department_id)
  where coalesce(progress,0)<100;
create index if not exists exits_active_count_idx on public.exits(employee_id)
  where status in ('Clearance in Progress','Cleared');

create or replace function public.get_navigation_counts(_self_only boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app as $$
declare
  _base jsonb;
  _user uuid:=auth.uid();
  _employee uuid:=app.current_employee_id();
  _today date:=(now() at time zone 'Asia/Kolkata')::date;
  _requests bigint:=0;
  _routine bigint:=0;
  _mine bigint:=0;
  _team bigint:=0;
  _payroll bigint:=0;
  _onboarding bigint:=0;
  _recruitment bigint:=0;
  _exits bigint:=0;
  _notifications bigint:=0;
  _mapping bigint:=0;
begin
  -- Validates the active account and non-null view before any new data can be counted.
  _base:=public.get_section_counts(_self_only);

  select count(*) into _notifications from public.notifications n
    where n.user_id=_user and n.read_at is null;

  if _employee is not null then
    select count(*) into _routine from public.routine_sets s
      join public.routine_items i on i.routine_id=s.id and i.is_active
      where s.employee_id=_employee and app.routine_can_tick(s,_today)
        and not exists(select 1 from public.routine_ticks t
          where t.routine_item_id=i.id and t.employee_id=s.employee_id and t.on_date=_today);
    select count(*) into _mine from public.goals g
      where g.employee_id=_employee and g.status='Active'
        and app.has_perm('goal.read',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id)
        and (app.has_perm('goal.update',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id)
          or app.has_perm('performance.manage',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id));
  end if;

  if not _self_only then
    if app.has_perm_any_scope('task.request') and app.has_perm_any_scope('employee.assign') then
      -- my_departments() supplies the same active department list used by Team Requests. Being
      -- the sender alone never makes a request actionable; the receiving permission is required.
      select count(*) into _requests from public.help_requests r
        join public.my_departments() d on d.id=r.to_department_id
        where r.status='Pending'
          and app.has_perm('task.request',r.entity_id,null,r.to_branch_id,r.to_department_id,null);
    end if;
    if app.has_perm_any_scope('performance.manage') and app.has_perm_any_scope('goal.read') then
      select count(*) into _team from public.goals g
        where g.employee_id is distinct from _employee and g.status='Active'
          and app.has_perm('goal.read',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id)
          and app.has_perm('performance.manage',g.entity_id,g.zone_id,g.branch_id,g.department_id,g.employee_id);
    end if;
    if app.has_perm_any_scope('payroll.manage') then
      select count(*) into _payroll from public.payroll_runs r
        where r.status='Draft' and r.entity_id is not null
          and app.has_perm('payroll.manage',r.entity_id,null,null,null,null);
    end if;
    if app.has_perm_any_scope('onboarding.manage') then
      select count(*) into _onboarding from public.onboarding o
        where coalesce(o.progress,0)<100
          and app.has_perm('onboarding.manage',o.entity_id,o.zone_id,o.branch_id,o.department_id,null);
    end if;
    if app.has_perm_any_scope('recruitment.manage') then
      select count(*) into _recruitment from public.candidates c
        where c.stage in ('Applied','Shortlisted','Interview','Offered')
          and app.has_perm('recruitment.manage',c.entity_id,c.zone_id,c.branch_id,c.department_id,null);
    end if;
    if app.has_perm_any_scope('exit.manage') then
      select count(*) into _exits from public.exits e
        where e.status in ('Clearance in Progress','Cleared')
          and e.employee_id is distinct from _employee and e.created_by is distinct from _user
          and app.has_perm('exit.manage',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.employee_id);
    end if;
    -- The pre-organization roster is deliberately shared with entity/global device managers.
    -- Match its SELECT policy and the link_device_code entry gate, not a wider any-scope grant.
    if app.has_perm_org_wide('device.manage') then
      select count(*) into _mapping from public.biotime_employees b
        where b.link_status in ('unmatched','ambiguous')
          and (b.employee_id is null or exists(select 1 from public.employees e
            where e.id=b.employee_id and app.has_perm('device.manage',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.id)));
    end if;
  end if;

  return _base||jsonb_build_object('task_requests',_requests,'task_routine',_routine,
    'performance_mine',_mine,'performance_team',_team,'payroll',_payroll,'onboarding',_onboarding,
    'recruitment',_recruitment,'exits',_exits,'notifications',_notifications,'attendance_mapping',_mapping);
end;
$$;
revoke all on function public.get_navigation_counts(boolean) from public,anon;
grant execute on function public.get_navigation_counts(boolean) to authenticated;
comment on function public.get_navigation_counts(boolean) is
  'Caller-scoped actionable navigation queues, personal routines/goals and complete unread inbox. Preserves get_section_counts; employee view suppresses management work.';

-- These queues were missing from realtime publication. Keep the default replica identity so
-- DELETE broadcasts carry opaque IDs rather than candidate, payroll or roster payloads.
do $$ declare _table text; begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach _table in array array['goals','payroll_runs','candidates','jobs','biotime_employees'] loop
    if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename=_table) then
      execute format('alter publication supabase_realtime add table public.%I',_table);
    end if;
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
