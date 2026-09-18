\set ON_ERROR_STOP on
-- Run after the standard-role matrix against its synthetic peers in five different scopes.
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable audit database required'; end if;
end $$;

-- Reapplying the migration preserves an explicitly configured custom role and every other grant.
insert into public.roles(key,name,rank) values ('audit_custom_administrator','Explicit account administrator',20);
insert into public.role_permissions(role_id,permission_id)
  select r.id,p.id from public.roles r cross join public.permissions p
  where r.key='audit_custom_administrator' and p.key in ('rbac.manage','employee.read');
create temporary table administration_permissions_before as table public.role_permissions;
\ir ../supabase/migrations/0148_administration_role_access.sql
do $$ begin
  assert not exists (
    (select * from public.role_permissions except select * from administration_permissions_before)
    union all
    (select * from administration_permissions_before except select * from public.role_permissions)
  ), 'idempotent migration preserves explicit custom and operational permissions';
end $$;
delete from public.roles where key='audit_custom_administrator';

-- Existing grants test actual revocation; a grant-then-revoke test alone can stop at INSERT.
insert into public.role_assignments(id,user_id,role_id,scope_type)
  select audit_test.id(9,n),audit_test.id(7,n),r.id,'self'
  from generate_series(1,5)n cross join public.roles r where r.key='employee';
insert into public.employees(id,entity_id,branch_id,department_id,employee_code,full_name)
  select audit_test.id(5,200+n),e.entity_id,e.branch_id,e.department_id,
    'PROVISION-'||n,'Provision Person '||n
  from generate_series(1,5)n join public.employees e on e.id=audit_test.id(5,n);

create function audit_test.admin_operation(_label text,_sql text,_allowed boolean,_error text)
returns void language plpgsql as $$
declare _actual boolean:=true;
begin
  begin
    execute _sql;
    raise exception using errcode='PZ002',message='Rollback successful administration test';
  exception
    when sqlstate 'PZ002' then null;
    when others then
      if _allowed or position(_error in sqlerrm)=0 then raise; end if;
      _actual:=false;
  end;
  perform audit_test.expect(_label,to_jsonb(_actual),to_jsonb(_allowed));
end $$;
grant execute on function audit_test.admin_operation(text,text,boolean,text) to authenticated;

set role authenticated;
do $$
declare a record; t integer; allowed boolean; prefix text;
begin
  for a in select * from audit_test.actors order by ordinal loop
    perform set_config('request.jwt.claim.sub',a.user_id::text,true);
    perform audit_test.expect(a.key||'/administration permission',to_jsonb(exists(
      select 1 from jsonb_array_elements(public.get_my_access()->'permissions') p
      where p->>'permission'='rbac.manage'
    )),to_jsonb(a.ordinal<=3));
    for t in 1..5 loop
      allowed:=a.ordinal<=3 and t<=a.visible_targets;
      prefix:=a.key||'/administration target '||t||'/';
      perform audit_test.write_expect(prefix||'revoke existing grant',format(
        'with removed as (delete from public.role_assignments where id=%L returning scope_type) select coalesce(jsonb_agg(scope_type),''[]''::jsonb) from removed',audit_test.id(9,t)),
        allowed,'["self"]');
      perform audit_test.admin_operation(prefix||'link login',format(
        'select public.link_user_to_employee(%L,%L)',audit_test.id(7,t),audit_test.id(5,t)),
        allowed,case when a.ordinal>=7 then 'at or above' else 'outside your scope' end);
      perform audit_test.admin_operation(prefix||'delete login',format(
        'select public.delete_login(%L)',audit_test.id(7,t)),
        allowed,'not allowed to delete');
      perform audit_test.admin_operation(prefix||'manual provisioning',format(
        'select public.grant_app_access(%L,%L,''Bright!River42'',''employee'',''self'',null)',
        audit_test.id(5,200+t),'provision-'||t||'@audit.invalid'),
        allowed,'not allowed to give app access');
      perform audit_test.admin_operation(prefix||'default provisioning',format(
        'select public.provision_employee_login(%L)',audit_test.id(5,200+t)),
        allowed,'not allowed to give app access');
      perform audit_test.admin_operation(prefix||'existing login metadata',format(
        'select public.provision_employee_login(%L)',audit_test.id(5,t)),
        allowed,'not allowed to give app access');
    end loop;
  end loop;
end $$;
reset role;

-- Real email identities let the password RPC exercise successful resets as well as denial.
insert into auth.identities(id,provider_id,user_id,identity_data,provider)
  select audit_test.id(8,200+n),audit_test.id(7,n)::text,audit_test.id(7,n),
    jsonb_build_object('sub',audit_test.id(7,n)::text),'email' from generate_series(1,5)n;
set role authenticated;
do $$
declare a record; t integer;
begin
  for a in select * from audit_test.actors order by ordinal loop
    perform set_config('request.jwt.claim.sub',a.user_id::text,true);
    for t in 1..5 loop
      perform audit_test.admin_operation(a.key||'/administration target '||t||'/reset password',format(
        'select public.admin_set_user_password(%L,''Bright!River42'')',audit_test.id(7,t)),
        a.ordinal<=3 and t<=a.visible_targets,
        case when a.ordinal>=7 then 'at or above' else 'outside your scope' end);
    end loop;
  end loop;
end $$;
reset role;
select 'PASS: Administration is restricted to scoped Super Admin, Entity Admin and HR; direct grants, revocation, login metadata, provisioning and password operations reject other standard roles' as result;
