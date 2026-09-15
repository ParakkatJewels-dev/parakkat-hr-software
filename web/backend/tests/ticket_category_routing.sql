\set ON_ERROR_STOP on
-- Run after the complete production migration history in the private, disposable test cluster.
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then raise exception 'Disposable ticket audit database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
create schema audit_ticket;
create function audit_ticket.id(kind integer,n integer) returns uuid language sql immutable as $$
  select ('d39'||lpad(kind::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create table audit_ticket.refs(key text primary key,id uuid not null);
create function audit_ticket.ref(key text) returns uuid language sql stable as $$
  select r.id from audit_ticket.refs r where r.key=$1
$$;
create function audit_ticket.expect_error(statement text, code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate=code then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % from %',code,statement;
end $$;
grant usage on schema audit_ticket to authenticated,anon;
grant execute on all functions in schema audit_ticket to authenticated,anon;
grant select,insert,update on audit_ticket.refs to authenticated;

insert into public.entities(id,code,name) select audit_ticket.id(1,n),'TICKET-E'||n,'Ticket company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name) select audit_ticket.id(2,n),audit_ticket.id(1,n),'TICKET-B'||n,'Ticket branch '||n from generate_series(1,2)n;
insert into public.departments(id,entity_id,branch_id,code,name) select audit_ticket.id(3,n),
  audit_ticket.id(1,case when n=4 then 2 else 1 end),audit_ticket.id(2,case when n=4 then 2 else 1 end),
  'TICKET-D'||n,case n when 1 then 'Technology' when 2 then 'People team' when 3 then 'Sales' else 'Other company' end
  from generate_series(1,4)n;
insert into auth.users(id,email) select audit_ticket.id(4,n),'ticket-actor-'||n||'@audit.invalid' from generate_series(1,12)n;
insert into public.employees(id,entity_id,branch_id,department_id,user_id,employee_code,full_name,status)
  select audit_ticket.id(5,n),audit_ticket.id(1,case when n=8 then 2 else 1 end),
    audit_ticket.id(2,case when n=8 then 2 else 1 end),
    audit_ticket.id(3,case when n in(3,4,6,9,11,12)then 2 when n in(5,7)then 3 when n=8 then 4 else 1 end),
    audit_ticket.id(4,n),'TICKET-ACTOR-'||n,'Ticket actor '||n,case when n=9 then 'Inactive' else 'Active' end
  from generate_series(1,12)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'TICKET-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_ticket.id(4,n),r.id,'self' from generate_series(1,12)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
  (audit_ticket.id(4,1),(select id from public.roles where key='entity_admin'),'entity',audit_ticket.id(1,1)),
  (audit_ticket.id(4,4),(select id from public.roles where key='dept_head'),'department',audit_ticket.id(3,2)),
  (audit_ticket.id(4,6),(select id from public.roles where key='hr_manager'),'entity',audit_ticket.id(1,1)),
  (audit_ticket.id(4,7),(select id from public.roles where key='hr_manager'),'department',audit_ticket.id(3,3)),
  (audit_ticket.id(4,10),(select id from public.roles where key='dept_head'),'department',audit_ticket.id(3,1));
insert into public.roles(key,name)values('audit_ticket_support','Ticket support permission');
insert into public.role_permissions(role_id,permission_id)select r.id,p.id from public.roles r cross join public.permissions p
  where r.key='audit_ticket_support' and p.key='ticket.manage';
insert into public.role_assignments(user_id,role_id,scope_type)select audit_ticket.id(4,11),id,'self' from public.roles where key='audit_ticket_support';
update auth.users set banned_until=now()+interval'1 day' where id=audit_ticket.id(4,12);

-- Old tickets remain free-text records with their original requester scope and no guessed route.
insert into public.tickets(id,employee_id,category,subject,created_at)values
  (audit_ticket.id(7,1),audit_ticket.id(5,2),'Old category','Legacy ticket','2000-01-01');
insert into public.ticket_categories(id,name,entity_id,department_id,branch_id)values
  (audit_ticket.id(6,99),'Foreign category',audit_ticket.id(1,2),audit_ticket.id(3,4),audit_ticket.id(2,2));

do $$ begin
  assert not has_table_privilege('authenticated','public.ticket_categories','insert,update,delete'),'category table mutations must go through checked RPC';
  assert not has_column_privilege('authenticated','public.tickets','routed_department_id','update'),'route cannot be rewritten directly';
  assert not has_column_privilege('authenticated','public.tickets','employee_id','update'),'requester cannot be rewritten directly';
  assert not has_function_privilege('anon','public.create_ticket(uuid,text,text,text)','execute'),'anonymous cannot create tickets';
  assert not has_function_privilege('authenticated','app.ticket_read_for(uuid,public.tickets)','execute'),'arbitrary user helper stays private';
end $$;
set role anon;
select audit_ticket.expect_error($q$select public.list_tickets()$q$,'42501');
select audit_ticket.expect_error($q$select public.save_ticket_category('Bad',audit_ticket.id(3,2))$q$,'42501');
set role authenticated;
select audit_ticket.expect_error($q$select public.get_ticket_access()$q$,'42501');
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000001';
insert into audit_ticket.refs values
  ('hr_category',public.save_ticket_category('People help',audit_ticket.id(3,2),_is_hr_queue=>true)),
  ('it_category',public.save_ticket_category('Laptop help',audit_ticket.id(3,1))),
  ('inactive_category',public.save_ticket_category('Retired category',audit_ticket.id(3,2),_is_active=>false));
do $$ begin
  assert (public.get_ticket_access()->>'can_manage_categories')::boolean,'entity admin can administer scoped categories';
  assert (select count(*)=3 from public.list_ticket_categories()),'admin sees active and inactive scoped categories';
end $$;
select audit_ticket.expect_error($q$select public.save_ticket_category('Outside',audit_ticket.id(3,4))$q$,'42501');
select audit_ticket.expect_error($q$select public.save_ticket_category(' people help ',audit_ticket.id(3,1))$q$,'23505');
select audit_ticket.expect_error($q$select public.save_ticket_category('',audit_ticket.id(3,2))$q$,'22023');

-- The requester belongs to Technology and can pick a People-team category in the same company.
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000002';
do $$ begin
  assert not (public.get_ticket_access()->>'can_manage_categories')::boolean,'requester cannot administer categories';
  assert (select count(*)=2 from public.list_ticket_categories()),'requester sees all active same-company destinations';
  assert exists(select 1 from public.ticket_categories where id=audit_ticket.ref('hr_category')),'category RLS allows cross-department picker';
  assert not exists(select 1 from public.ticket_categories where id=audit_ticket.id(6,99)),'foreign-company category hidden';
end $$;
select audit_ticket.expect_error($q$select public.save_ticket_category('Unauthorized',audit_ticket.id(3,2))$q$,'42501');
select audit_ticket.expect_error($q$select public.create_ticket(audit_ticket.ref('inactive_category'),'Inactive')$q$,'22023');
select audit_ticket.expect_error($q$select public.create_ticket(audit_ticket.id(6,99),'Foreign')$q$,'22023');
select audit_ticket.expect_error($q$select public.create_ticket(null,'Missing category')$q$,'22023');
select audit_ticket.expect_error($q$select public.create_ticket(audit_ticket.ref('hr_category'),' ','High')$q$,'22023');
insert into audit_ticket.refs values('hr_ticket',public.create_ticket(audit_ticket.ref('hr_category'),'Need policy clarification','High','Synthetic request')),
  ('it_ticket',public.create_ticket(audit_ticket.ref('it_category'),'Laptop setup'));
do $$ begin
  assert (select department_id=audit_ticket.id(3,1) and routed_department_id=audit_ticket.id(3,2)
    and category='People help' and is_hr_queue and status='Open' from public.tickets where id=audit_ticket.ref('hr_ticket')),
    'requester ancestry and receiver route remain separate';
  assert (select count(*)=3 from public.list_tickets()),'requester retains old open ticket and own routed requests';
  assert (select not can_manage from public.list_tickets() where id=audit_ticket.ref('hr_ticket')),'requester cannot sanction own support request';
end $$;
select audit_ticket.expect_error($q$select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'Resolved')$q$,'42501');
select audit_ticket.expect_error($q$update public.tickets set routed_department_id=audit_ticket.id(3,1) where id=audit_ticket.ref('hr_ticket')$q$,'42501');

-- Ordinary receiving-department staff can read the queue; only explicit handlers and its head manage it.
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000003';
do $$ begin
  assert exists(select 1 from public.tickets where id=audit_ticket.ref('hr_ticket')),'receiving staff see routed ticket despite self-only ticket.read';
  assert not exists(select 1 from public.tickets where id=audit_ticket.ref('it_ticket')),'receiving staff cannot read a different destination';
  assert not exists(select 1 from public.tickets where id=audit_ticket.id(7,1)),'legacy requester scope is preserved';
  assert (select employee->>'full_name'='Ticket actor 2' from public.list_tickets() where id=audit_ticket.ref('hr_ticket')),
    'handler gets requester miniidentity even when directory employee RLS is narrower';
  assert (select not can_manage from public.list_tickets() where id=audit_ticket.ref('hr_ticket')),'read access is not handling permission';
  assert exists(select 1 from public.notifications where type='ticket' and ref_id=audit_ticket.ref('hr_ticket')),'receiving staff are notified';
end $$;
select audit_ticket.expect_error($q$select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'Resolved')$q$,'42501');
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000004';
do $$ begin
  assert (select can_manage from public.list_tickets() where id=audit_ticket.ref('hr_ticket')),'receiving department head can handle routed ticket';
end $$;
select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'In Progress');
select audit_ticket.expect_error($q$select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'Invented status')$q$,'22023');
select audit_ticket.expect_error($q$update public.tickets set status='Invented status' where id=audit_ticket.ref('hr_ticket')$q$,'22023');
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000011';
select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'On Hold');

-- Requester department, unrelated department, foreign company and inactive/banned actors stay out.
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000010';
do $$ begin
  assert not exists(select 1 from public.tickets where id=audit_ticket.ref('hr_ticket')),'requester department head cannot inspect another department queue';
  assert not exists(select 1 from public.notifications where ref_id=audit_ticket.ref('hr_ticket')),'notification is not sent to requester department';
end $$;
select audit_ticket.expect_error($q$select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'Resolved')$q$,'42501');
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000005';
do $$ begin assert not exists(select 1 from public.list_tickets() where id=audit_ticket.ref('hr_ticket')),'unrelated department sees no routed ticket'; end $$;
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000008';
do $$ begin assert not exists(select 1 from public.list_tickets()),'other company sees no ticket'; end $$;
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000009';
do $$ begin assert not exists(select 1 from public.list_tickets()),'inactive staff see no ticket'; end $$;
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000012';
do $$ begin assert not exists(select 1 from public.list_tickets()),'banned staff see no ticket'; end $$;

-- HR has oversight according to its actual grant, and the explicit HR queue flag is a filter only.
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000006';
do $$ begin
  assert (public.get_ticket_access()->>'is_hr')::boolean,'actual HR role enables HR view';
  assert not (public.get_ticket_access()->>'can_manage_categories')::boolean,'HR alone is not category administrator';
  assert (select count(*)=3 from public.list_tickets()),'entity HR can see every visible destination and legacy request';
  assert (select count(*)=1 from public.list_tickets() where is_hr_queue),'HR-filter distinguishes requests routed to HR';
end $$;
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000007';
do $$ begin
  assert (public.get_ticket_access()->>'is_hr')::boolean,'narrow HR still gets HR view';
  assert not exists(select 1 from public.list_tickets()),'narrow HR is never widened to all entity tickets';
end $$;

-- Editing or disabling a category affects future tickets only.
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000001';
select public.save_ticket_category('People help renamed',audit_ticket.id(3,3),audit_ticket.ref('hr_category'),false,false);
do $$ begin
  assert (select routed_department_id=audit_ticket.id(3,2) and category='People help' and is_hr_queue
    from public.tickets where id=audit_ticket.ref('hr_ticket')),'historic ticket keeps routing, category name and HR queue snapshot';
end $$;
select audit_ticket.expect_error($q$update public.tickets set category_id=audit_ticket.ref('it_category') where id=audit_ticket.ref('hr_ticket')$q$,'42501');
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000002';
select audit_ticket.expect_error($q$select public.create_ticket(audit_ticket.ref('hr_category'),'Disabled')$q$,'22023');
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000004';
select public.set_ticket_status(audit_ticket.ref('hr_ticket'),'Resolved');

-- No arbitrary ticket count cap, and unresolved work remains after the history window.
reset role;
set request.jwt.claim.sub='';
insert into public.tickets(employee_id,category_id,subject,created_at)
  select audit_ticket.id(5,2),audit_ticket.ref('it_category'),'Old open '||n,'2000-01-01' from generate_series(1,105)n;
insert into public.tickets(employee_id,category_id,subject,status,created_at)
  values(audit_ticket.id(5,2),audit_ticket.ref('it_category'),'Old resolved','Resolved','2000-01-01');
do $$ begin
  assert not exists(select 1 from public.notifications where ref_id=audit_ticket.ref('hr_ticket')
    and user_id in(audit_ticket.id(4,5),audit_ticket.id(4,8),audit_ticket.id(4,9),audit_ticket.id(4,10),audit_ticket.id(4,12))),
    'routing notifications cannot leak to unrelated, foreign, inactive or banned users';
end $$;
set role authenticated;
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000002';
do $$ begin
  assert (select count(*)=105 from public.list_tickets() where subject like 'Old open %'),'every old open ticket remains visible';
  assert not exists(select 1 from public.list_tickets() where subject='Old resolved'),'old resolved history remains bounded';
  assert exists(select 1 from public.notifications where ref_id=audit_ticket.ref('hr_ticket') and title='Ticket resolved'),
    'requester receives status updates';
end $$;
reset role;
set request.jwt.claim.sub='';
delete from public.role_assignments where user_id=audit_ticket.id(4,2);
set role authenticated;
set request.jwt.claim.sub='d3900004-0000-0000-0000-000000000002';
do $$ begin
  assert not exists(select 1 from public.list_tickets()),'revoked ticket access also removes requester-owned reads';
end $$;
select audit_ticket.expect_error($q$select public.create_ticket(audit_ticket.ref('it_category'),'Revoked requester')$q$,'42501');
reset role;
set request.jwt.claim.sub='';
select 'PASS: ticket category administration, immutable department routing, HR scope/filter, receiving staff/head access, notifications and legacy/open-history boundaries' as result;
