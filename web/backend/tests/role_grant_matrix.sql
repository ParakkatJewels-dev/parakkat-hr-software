\set ON_ERROR_STOP on
-- Who may give which role, at which area. Every granter actor tries to give every role to target
-- login 1 (company 1, branch 1, department 1) at every scope level, both inside its own company and
-- in the other company. Each attempt is a real INSERT into public.role_assignments as that
-- authenticated user, rolled back in its own subtransaction, so RLS and the guard trigger decide.
-- Run after administration_access.sql; the results feed tests/fixtures/role-grant-matrix.json.
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable audit database required'; end if;
end $$;

-- Two custom (non-system) roles at the default custom rank: one harmless, one administrative.
insert into public.roles(key,name,rank,is_system) values
  ('audit_custom_basic','Audit custom basic',20,false),
  ('audit_custom_admin','Audit custom administrator',20,false);
insert into public.role_permissions(role_id,permission_id)
  select r.id,p.id from public.roles r join public.permissions p
    on (r.key='audit_custom_basic' and p.key='attendance.read') or (r.key='audit_custom_admin' and p.key='rbac.manage');

-- Dimensions. Role ids are resolved here so a role hidden by RLS can never look like a refusal.
create table audit_test.grant_roles(ordinal integer primary key, key text unique, role_id uuid not null, rank integer, is_system boolean);
insert into audit_test.grant_roles
  select k.ordinal,k.key,r.id,r.rank,r.is_system
  from unnest(array['employee','dept_head','branch_manager','zonal_manager','hr_manager','entity_admin','super_admin',
    'audit_custom_basic','audit_custom_admin']) with ordinality k(key,ordinal)
  join public.roles r on r.key=k.key;
create table audit_test.grant_places(ordinal integer primary key, level public.scope_type, place text, scope_id uuid, unique(level,place));
insert into audit_test.grant_places values
  (1,'self','n/a',null),
  (2,'department','inside',audit_test.id(4,1)),(3,'department','other_company',audit_test.id(4,5)),
  (4,'branch','inside',audit_test.id(3,1)),(5,'branch','other_company',audit_test.id(3,4)),
  (6,'zone','inside',audit_test.id(2,1)),(7,'zone','other_company',audit_test.id(2,3)),
  (8,'entity','inside',audit_test.id(1,1)),(9,'entity','other_company',audit_test.id(1,2)),
  (10,'global','n/a',null);
-- Each granter's own ceiling: the highest rank it actually holds (unassigned holds nothing).
create table audit_test.grant_granters as
  select a.ordinal,a.key,a.user_id,a.scope_type,a.scope_id,coalesce(max(r.rank),0) rank
  from audit_test.actors a left join public.role_assignments ra on ra.user_id=a.user_id
  left join public.roles r on r.id=ra.role_id group by 1,2,3,4,5;
create table audit_test.grant_results(granter text, role text, level text, place text, allowed boolean not null,
  outcome text not null, primary key(granter,role,level,place));
grant select on audit_test.grant_roles,audit_test.grant_places to authenticated;
grant select,insert on audit_test.grant_results to authenticated;

-- The fixture geometry the "inside" / "other company" labels rely on.
do $$ begin
  if (select count(*) from audit_test.grant_roles)<>9 then raise exception 'FAIL: expected 9 target roles'; end if;
  if (select count(*) from public.role_permissions rp join audit_test.grant_roles g on g.role_id=rp.role_id
      where g.key like 'audit_custom_%')<>2 then raise exception 'FAIL: custom role permissions missing'; end if;
  if not exists (select 1 from public.departments d join public.branches b on b.id=d.branch_id
      where d.id=audit_test.id(4,1) and d.entity_id=audit_test.id(1,1) and b.id=audit_test.id(3,1) and b.zone_id=audit_test.id(2,1))
    or not exists (select 1 from public.zones where id=audit_test.id(2,1) and entity_id=audit_test.id(1,1))
    or (select count(*) from (
          select entity_id from public.departments where id=audit_test.id(4,5)
          union all select entity_id from public.branches where id=audit_test.id(3,4)
          union all select entity_id from public.zones where id=audit_test.id(2,3)) other
        where entity_id=audit_test.id(1,2))<>3
    or not exists (select 1 from public.profiles p join public.employees e on e.id=p.employee_id
      where p.user_id=audit_test.id(7,1) and e.entity_id=audit_test.id(1,1) and e.branch_id=audit_test.id(3,1)
        and e.department_id=audit_test.id(4,1))
  then raise exception 'FAIL: role grant fixture geometry changed'; end if;
end $$;

-- administration_access.sql leaves employee@self on target 1. Park its grants so no attempt is a
-- duplicate of something the target already holds; they are restored unchanged at the end.
create table audit_test.grant_target_stash as select * from public.role_assignments where user_id=audit_test.id(7,1);
delete from public.role_assignments where user_id=audit_test.id(7,1);

set role authenticated;
do $$
declare a record; r record; p record; n integer; outcome text; msg text;
begin
  for a in select * from audit_test.actors order by ordinal loop
    perform set_config('request.jwt.claim.sub',a.user_id::text,true);
    for r in select * from audit_test.grant_roles order by ordinal loop
      for p in select * from audit_test.grant_places order by ordinal loop
        begin
          insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
            values (audit_test.id(7,1),r.role_id,p.level,p.scope_id);
          get diagnostics n=row_count;
          if n<>1 then raise exception 'FAIL %/%/%/%: insert reported % rows',a.key,r.key,p.level,p.place,n; end if;
          raise exception using errcode='PZ003',message='Rollback successful grant';
        exception
          when sqlstate 'PZ003' then outcome:='granted';
          when unique_violation then
            raise exception 'FAIL %/%/%/%: target already holds this exact assignment',a.key,r.key,p.level,p.place;
          when insufficient_privilege then
            get stacked diagnostics msg=message_text;
            if msg not like 'new row violates row-level security policy%' then raise; end if;
            outcome:='rls';
          when raise_exception then
            -- Only the guard's two refusal messages count as "refused"; anything else fails loudly.
            get stacked diagnostics msg=message_text;
            if msg='not authorized to grant this role at this scope' then outcome:='not_authorized';
            elsif msg=format('%s cannot be granted at %s scope',r.key,p.level) then outcome:='scope_mismatch';
            else raise; end if;
        end;
        insert into audit_test.grant_results values (a.key,r.key,p.level::text,p.place,outcome='granted',outcome);
      end loop;
    end loop;
  end loop;
end $$;
reset role;

-- An independent statement of the expected rules (0019 role levels, 0044 ranks, 0091/0095 HR cap,
-- 0045 custom administrative roles, 0033 grantee confinement for employee@self).
create function audit_test.expected_grant(_granter text,_role text,_level text,_place text) returns boolean
language sql immutable as $$
  select case
    when not case _role
      when 'super_admin' then _level='global'
      when 'entity_admin' then _level='entity'
      when 'hr_manager' then _level in ('entity','zone','branch','department')
      when 'zonal_manager' then _level='zone'
      when 'branch_manager' then _level='branch'
      when 'dept_head' then _level='department'
      when 'employee' then _level='self'
      else true end then false
    when _granter='super_admin' then true
    when _place='other_company' or _level='global' or _role='super_admin' then false
    when _role='employee' then _granter in ('entity_admin','hr_manager')
    when _level='self' then false
    when _granter='entity_admin' then _role in ('hr_manager','zonal_manager','branch_manager','dept_head','audit_custom_basic','audit_custom_admin')
    when _granter='hr_manager' then _role in ('dept_head','audit_custom_basic')
    else false end
$$;
create function audit_test.grant_none(_label text,_offenders jsonb) returns text language plpgsql as $$
begin
  if coalesce(jsonb_array_length(_offenders),0)>0 then raise exception 'FAIL %: %',_label,_offenders; end if;
  return 'PASS: '||_label;
end $$;
create view audit_test.grant_matrix as
  select g.*,ro.rank role_rank,ro.is_system,gr.rank granter_rank
  from audit_test.grant_results g join audit_test.grant_roles ro on ro.key=g.role join audit_test.grant_granters gr on gr.key=g.granter;

select audit_test.grant_none(format('%s rolled-back grant attempts: 8 granters x 9 roles x 10 role areas, each granted or refused by RLS/guard',count(*)),
  (select jsonb_agg(x) from (
    select jsonb_build_object('attempts',count(*)) x from audit_test.grant_results having count(*)<>720
    union all select to_jsonb(g) from audit_test.grant_results g where g.outcome not in ('granted','not_authorized','scope_mismatch','rls')
  ) bad)) as result from audit_test.grant_results;
select audit_test.grant_none('Only Super Admin grants Super Admin, or anything at global scope',
  (select jsonb_agg(to_jsonb(g)) from audit_test.grant_results g
   where g.allowed and g.granter<>'super_admin' and (g.role='super_admin' or g.level='global'))) as result;
select audit_test.grant_none('Apart from Super Admin, nobody grants a role ranked at or above their own highest rank',
  (select jsonb_agg(to_jsonb(g)) from audit_test.grant_matrix g
   where g.allowed and g.granter<>'super_admin' and g.role_rank>=g.granter_rank)) as result;
select audit_test.grant_none('HR Manager grants nothing ranked above Department Head, yet can give Department Head and Employee',
  (select jsonb_agg(x) from (
    select to_jsonb(g) x from audit_test.grant_matrix g where g.granter='hr_manager' and g.allowed and g.role_rank>30
    union all select jsonb_build_object('missing',k) from unnest(array['dept_head/department','employee/self']) k
     where not exists (select 1 from audit_test.grant_results g where g.granter='hr_manager' and g.allowed and g.role||'/'||g.level=k)
  ) bad)) as result;
select audit_test.grant_none('The custom administrative role (rbac.manage) is grantable only by rank 80+: Entity Admin and Super Admin',
  (select jsonb_agg(x) from (
    select jsonb_build_object('granters',coalesce(jsonb_agg(distinct granter order by granter),'[]')) x
      from audit_test.grant_results where role='audit_custom_admin' and allowed
    having coalesce(jsonb_agg(distinct granter order by granter),'[]')<>'["entity_admin", "super_admin"]'::jsonb
  ) bad)) as result;
select audit_test.grant_none('Built-in roles are granted only at their 0019 levels, and Super Admin can use every one of those levels in both companies',
  (select jsonb_agg(x) from (
    select to_jsonb(g) x from audit_test.grant_matrix g where g.allowed and g.is_system and not case g.role
      when 'super_admin' then g.level='global' when 'entity_admin' then g.level='entity'
      when 'hr_manager' then g.level in ('entity','zone','branch','department') when 'zonal_manager' then g.level='zone'
      when 'branch_manager' then g.level='branch' when 'dept_head' then g.level='department' when 'employee' then g.level='self' end
    union all select to_jsonb(g) from audit_test.grant_matrix g where g.granter='super_admin' and g.is_system
      and (g.outcome='scope_mismatch')=g.allowed
    union all select to_jsonb(g) from audit_test.grant_results g where g.outcome='scope_mismatch'
      and exists (select 1 from audit_test.grant_roles ro where ro.key=g.role and not ro.is_system)
  ) bad)) as result;
select audit_test.grant_none('Nobody grants in another company except Super Admin, who can',
  (select jsonb_agg(x) from (
    select to_jsonb(g) x from audit_test.grant_results g where g.allowed and g.place='other_company' and g.granter<>'super_admin'
    union all select jsonb_build_object('super_admin_other_company_grants',count(*)) from audit_test.grant_results g
      where g.granter='super_admin' and g.place='other_company' and g.allowed having count(*)=0
  ) bad)) as result;
select audit_test.grant_none('Employee, unassigned, and managers without rbac.manage (Zonal, Branch, Department Head) grant nothing',
  (select jsonb_agg(to_jsonb(g)) from audit_test.grant_results g
   where g.allowed and g.granter in ('employee','unassigned','zonal_manager','branch_manager','dept_head'))) as result;
select audit_test.grant_none(format('All %s outcomes match the independent expected rule table',count(*)),
  (select jsonb_agg(to_jsonb(g)) from audit_test.grant_results g
   where g.allowed is distinct from audit_test.expected_grant(g.granter,g.role,g.level,g.place))) as result
  from audit_test.grant_results;

-- Recorded, not asserted: which grantee a delegated administrator may give a role to. Target 5 is
-- an employee of company 2; the area granted is inside the granter's own company 1.
create table audit_test.grant_grantee_notes(granter text, role text, level text, allowed boolean, outcome text);
grant select,insert on audit_test.grant_grantee_notes to authenticated;
set role authenticated;
do $$
declare a record; r record; outcome text; msg text;
begin
  for a in select * from audit_test.actors where key in ('entity_admin','hr_manager') order by ordinal loop
    perform set_config('request.jwt.claim.sub',a.user_id::text,true);
    for r in select g.key,g.role_id,p.level,p.scope_id from audit_test.grant_roles g join audit_test.grant_places p
        on (g.key='employee' and p.level='self') or (g.key='dept_head' and p.level='department' and p.place='inside') loop
      begin
        insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values (audit_test.id(7,5),r.role_id,r.level,r.scope_id);
        raise exception using errcode='PZ003',message='Rollback successful grant';
      exception
        when sqlstate 'PZ003' then outcome:='granted';
        when raise_exception then
          get stacked diagnostics msg=message_text;
          if msg<>'not authorized to grant this role at this scope' then raise; end if;
          outcome:='not_authorized';
      end;
      insert into audit_test.grant_grantee_notes values (a.key,r.key,r.level::text,outcome='granted',outcome);
    end loop;
  end loop;
end $$;
reset role;
select 'NOTE: grantee in another company (target 5, company 2), area inside granter''s company: '||
  string_agg(granter||' '||role||'@'||level||'='||case when allowed then 'granted' else 'refused' end,', ' order by granter,role)
  as result from audit_test.grant_grantee_notes;

-- Leave the shared fixture as it was for the suites that follow.
insert into public.role_assignments select * from audit_test.grant_target_stash;
delete from public.roles where key in ('audit_custom_basic','audit_custom_admin');
