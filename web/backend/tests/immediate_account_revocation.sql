\set ON_ERROR_STOP on
-- Existing JWT identity remains unchanged while the account changes in the authoritative tables.
do $$ begin
  if current_database() not in ('hr_message_requests_audit','hr_request_integrity_audit') then
    raise exception 'Disposable account-revocation database required';
  end if;
end $$;
begin;
reset role;
set local request.jwt.claim.sub='';
create schema audit_revocation;
create function audit_revocation.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('d44'||lpad(kind::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create function audit_revocation.fail(statement text,code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate=code then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % for %',code,statement;
end $$;
create function audit_revocation.no_access() returns void language plpgsql as $$
declare _table record; _count bigint; _changed bigint;
begin
  assert not app.session_is_active(),'existing JWT no longer authorizes this account';
  assert not app.is_super_admin(),'super-admin flag and role do not bypass account state';
  assert app.current_employee_id() is null,'self-policy identity revoked';
  assert app.max_role_rank()=0 and app.max_grantable_rank()=0,'grant rank revoked';
  assert not app.has_perm('employee.read',audit_revocation.id(1,1),null,audit_revocation.id(2,1),null,audit_revocation.id(4,1)),'scoped permission revoked';
  assert not app.has_perm_any_scope('employee.read') and not app.has_perm_org_wide('employee.read')
    and not app.has_perm_at_branch_or_wider('employee.read') and not app.has_perm_globally('employee.read'),'all grant helper variants revoked';
  assert (select count(*) from app.visible_branch_ids())=0 and (select count(*) from app.readable_entity_ids())=0,'raw grant organization helpers revoked';
  assert not app.can_read_org(audit_revocation.id(1,1)),'org permission revoked';
  -- Every application table that exposes SELECT to authenticated must deny rows, including
  -- constant reads and auth.uid-only self policies. Platform storage metadata is not HRMS data.
  -- Security-invoker application views are checked too.
  for _table in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' or (n.nspname='storage' and c.relname='objects')) and c.relkind in ('r','p','v')
      and has_table_privilege('authenticated',c.oid,'select')
      and (c.relrowsecurity or c.relkind='v')
  loop
    execute format('select count(*) from %I.%I',_table.nspname,_table.relname) into _count;
    assert _count=0,format('Revoked account read %s rows from %I.%I',_count,_table.nspname,_table.relname);
  end loop;
  assert public.list_managed_users()='[]'::jsonb,'definer user listing revoked';
  assert (select count(*) from public.asset_for_object(audit_revocation.id(6,1)::text||'/photo.jpg'))=0,'definer asset resolver revoked';
  assert (select count(*) from public.list_tickets(null))=0,'ticket definer listing revoked';
  perform audit_revocation.fail('select public.get_my_access()','42501');
  perform audit_revocation.fail('select public.get_section_counts()','42501');
  perform audit_revocation.fail('select public.get_developer_settings()','PT403');
  perform audit_revocation.fail('select public.provision_employee_login(audit_revocation.id(4,1))','42501');
  perform audit_revocation.fail('select public.move_employee_to_department(audit_revocation.id(4,1),null)','42501');
  perform audit_revocation.fail('select public.update_help_request(audit_revocation.id(7,1))','42501');
  perform audit_revocation.fail('select public.respond_to_help_request(audit_revocation.id(7,1),true)','42501');
  perform audit_revocation.fail('select public.cancel_help_request(audit_revocation.id(7,1))','42501');
  perform audit_revocation.fail('select public.update_requested_task(audit_revocation.id(8,1))','42501');
  perform audit_revocation.fail('select app.actor_name(auth.uid())','42501');
  perform audit_revocation.fail('select app.derive_login_email(audit_revocation.id(4,1))','42501');
  perform audit_revocation.fail('select app.derive_login_password(audit_revocation.id(4,1))','42501');
  perform audit_revocation.fail('select app.ensure_employee_self_role(auth.uid(),null)','42501');
  perform audit_revocation.fail($q$select app.notify_perm_holders('employee.read',null,null,null,null,'test','Injected','Body','employees',null)$q$,'42501');
  perform audit_revocation.fail('select public.create_ticket(null,''Revoked submit'')','42501');
  perform audit_revocation.fail('insert into public.expenses(employee_id,amount) values(audit_revocation.id(4,1),100)','42501');
  update public.notifications set read_at=now() where user_id=auth.uid();
  get diagnostics _changed=row_count;
  assert _changed=0,'auth.uid-only own notification update revoked';
  delete from public.notifications where user_id=auth.uid();
  get diagnostics _changed=row_count;
  assert _changed=0,'auth.uid-only own notification delete revoked';
end $$;
grant usage on schema audit_revocation to authenticated,anon,service_role;
grant execute on all functions in schema audit_revocation to authenticated,anon,service_role;

insert into public.entities(id,code,name) values(audit_revocation.id(1,1),'REVOKE-E1','Revocation company');
insert into public.branches(id,entity_id,code,name) values(audit_revocation.id(2,1),audit_revocation.id(1,1),'REVOKE-B1','Revocation branch');
insert into auth.users(id,email) select audit_revocation.id(3,n),'revocation-actor-'||n||'@audit.invalid' from generate_series(1,4)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status)
  select audit_revocation.id(4,n),audit_revocation.id(1,1),audit_revocation.id(2,1),audit_revocation.id(3,n),
    'REVOKE-ACTOR-'||n,'Revocation actor '||n,'Active' from generate_series(1,3)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'REVOKE-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_revocation.id(3,n),r.id,'self' from generate_series(1,3)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_revocation.id(3,2),r.id,'entity',audit_revocation.id(1,1) from public.roles r where r.key='hr_manager';
update public.profiles set is_super_admin=true where user_id in (audit_revocation.id(3,3),audit_revocation.id(3,4));
insert into public.notifications(id,user_id,type,title) select audit_revocation.id(5,n),audit_revocation.id(3,n),'test','Private reminder' from generate_series(1,4)n;
insert into public.assets(id,entity_id,branch_id,name,status) values(audit_revocation.id(6,1),audit_revocation.id(1,1),audit_revocation.id(2,1),'Test laptop','Available');
insert into storage.objects(bucket_id,name) values('asset-photos',audit_revocation.id(6,1)::text||'/photo.jpg');
insert into public.expenses(employee_id,amount,status) values(audit_revocation.id(4,1),100,'Pending');

set local role authenticated;
select set_config('request.jwt.claim.sub',audit_revocation.id(3,2)::text,true);
do $$ begin
  assert app.session_is_active(),'active HR login works';
  assert (select count(*) from public.employees where entity_id=audit_revocation.id(1,1))=3,'active HR can read company workforce';
  assert (public.get_my_access()->'permissions') <> '[]'::jsonb,'active access payload populated';
  assert (select count(*) from public.notifications where id=audit_revocation.id(5,2))=1,'active self notification read';
end $$;
reset role;
update public.employees set status='Inactive' where id=audit_revocation.id(4,2);
set local role authenticated;
select audit_revocation.no_access();
reset role;
update public.employees set status='Active' where id=audit_revocation.id(4,2);
set local role authenticated;
do $$ begin assert app.session_is_active() and (select count(*) from public.employees where entity_id=audit_revocation.id(1,1))=3,'reactivation restores granted access'; end $$;

-- Same signed-in identity, now banned. Expiring a ban restores access without new assignments.
reset role;
update auth.users set banned_until=now()+interval '1 day' where id=audit_revocation.id(3,2);
set local role authenticated;
select audit_revocation.no_access();
reset role;
update auth.users set banned_until=now()-interval '1 second' where id=audit_revocation.id(3,2);
set local role authenticated;
do $$ begin assert app.session_is_active(),'expired ban no longer blocks active account'; end $$;
reset role;
update auth.users set deleted_at=now() where id=audit_revocation.id(3,2);
set local role authenticated;
select audit_revocation.no_access();
reset role;
update auth.users set deleted_at=null where id=audit_revocation.id(3,2);

-- Ordinary employee has no manager grant to revoke; direct self policies must still close.
set local role authenticated;
select set_config('request.jwt.claim.sub',audit_revocation.id(3,1)::text,true);
do $$ begin assert (select count(*) from public.employees where entity_id=audit_revocation.id(1,1))=1,'employee starts with own-row access'; end $$;
reset role;
update public.employees set status='Inactive' where id=audit_revocation.id(4,1);
set local role authenticated;
select audit_revocation.no_access();
reset role;
update public.employees set status='Active' where id=audit_revocation.id(4,1);

-- Linked super-admin flags cannot override deactivation, including developer API authority.
set local role authenticated;
select set_config('request.jwt.claim.sub',audit_revocation.id(3,3)::text,true);
do $$ begin assert app.is_super_admin(),'active super-admin is preserved'; end $$;
reset role;
update public.employees set status='Inactive' where id=audit_revocation.id(4,3);
do $$ begin assert not app.developer_admin_active(audit_revocation.id(3,3)),'inactive developer key creator loses key authority'; end $$;
set local role authenticated;
select audit_revocation.no_access();
reset role;
update public.employees set status='Active' where id=audit_revocation.id(4,3);

-- System administrator without an employee row is intentionally permitted, until banned.
set local role authenticated;
select set_config('request.jwt.claim.sub',audit_revocation.id(3,4)::text,true);
do $$ begin
  assert app.session_is_active() and app.is_super_admin(),'unlinked administrator remains valid';
  assert (public.get_my_access()->>'is_super_admin')::boolean,'unlinked admin access payload';
end $$;
reset role;
update auth.users set banned_until=now()+interval '1 day' where id=audit_revocation.id(3,4);
set local role authenticated;
select audit_revocation.no_access();
reset role;
set local request.jwt.claim.sub='';
-- The worker validates an explicit actor, even though its database connection itself bypasses
-- RLS. This separate contract prevents an already-queued command from retaining old authority.
update public.employees set status='Inactive' where id=audit_revocation.id(4,3);
do $$ begin
  assert (select count(*) from public.notifications where id in (audit_revocation.id(5,1),audit_revocation.id(5,2),audit_revocation.id(5,3),audit_revocation.id(5,4)) and read_at is null)=4,'denied mutation attempts preserve notifications';
  assert not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' or (n.nspname='storage' and c.relname='objects')) and c.relkind in ('r','p') and c.relrowsecurity
      and not exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='active_account_required' and not p.polpermissive)), 'all existing application RLS tables and storage objects have the restrictive guard';
  assert not has_function_privilege('authenticated','app.derive_login_password(uuid)','execute')
    and not has_function_privilege('anon','app.derive_login_password(uuid)','execute'),'credential derivation is owner-only';
end $$;
set local role service_role;
do $$ begin
  assert (select count(*) from public.employees where entity_id=audit_revocation.id(1,1))=3,'trusted service reads retain bypass';
  assert app.account_is_active(audit_revocation.id(3,2)),'worker sees active queued actor';
  assert not app.account_is_active(audit_revocation.id(3,3)),'worker rejects inactive queued actor';
  assert not app.account_is_active(audit_revocation.id(3,4)),'worker rejects banned queued actor';
  assert not app.account_is_active(audit_revocation.id(3,99)),'worker rejects nonexistent queued actor';
end $$;
reset role;
rollback;
select 'PASS: immediate inactive/banned/deleted JWT revocation across RLS, self policies, invoker views, definer RPCs, admin flags and developer-key authority; active/service paths preserved' as result;
