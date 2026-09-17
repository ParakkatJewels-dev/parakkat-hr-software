\set ON_ERROR_STOP on
-- Production migrations, real row policies and isolated fixtures; never target a hosted database.
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then
    raise exception 'Disposable device employee audit database required';
  end if;
end $$;
begin;
reset role;
set local request.jwt.claim.sub = '';
create schema audit_device_employee;
create function audit_device_employee.id(kind integer, n integer) returns uuid language sql immutable as $$
  select ('d47' || lpad(kind::text,5,'0') || '-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
grant usage on schema audit_device_employee to authenticated, service_role;
grant execute on all functions in schema audit_device_employee to authenticated, service_role;

-- Auto-creation requires one active company, independent of other suites' companies.
update public.entities set is_active=false;
insert into public.entities(id,code,name,is_active) values
  (audit_device_employee.id(1,1),'DEVICE-AUDIT-E1','Device audit company',true),
  (audit_device_employee.id(1,2),'DEVICE-AUDIT-E2','Other device audit company',false);
insert into public.branches(id,entity_id,code,name) values
  (audit_device_employee.id(2,1),audit_device_employee.id(1,1),'DEVICE-AUDIT-B1','Device audit branch');
insert into public.departments(id,entity_id,branch_id,code,name,is_active) values
  (audit_device_employee.id(3,1),audit_device_employee.id(1,1),audit_device_employee.id(2,1),'DEVICE-UNIQUE','Device Unique Department',true),
  (audit_device_employee.id(3,2),audit_device_employee.id(1,1),null,'DEVICE-DUP-1','Device Duplicate Department',true),
  (audit_device_employee.id(3,3),audit_device_employee.id(1,1),null,'DEVICE-DUP-2','Device Duplicate Department',true),
  (audit_device_employee.id(3,4),audit_device_employee.id(1,1),null,'DEVICE-INACTIVE','Device Retired Department',false);
insert into public.employees(id,entity_id,employee_code,full_name,status,meta) values
  (audit_device_employee.id(4,1),audit_device_employee.id(1,1),'DEVICE-AUDIT-HELD','Established Staff Holder','Active','{"hr_note":"preserve"}'),
  (audit_device_employee.id(4,2),audit_device_employee.id(1,1),'DEVICE-AUDIT-EXACT','HR Correct Legal Name','Inactive','{"hr_note":"do not replace"}'),
  (audit_device_employee.id(4,3),audit_device_employee.id(1,1),'HR-AUDIT-METADATA','Metadata Identity Holder','Inactive','{"device_emp_code":"DEVICE-AUDIT-META","hr_note":"preserve"}'),
  (audit_device_employee.id(4,4),audit_device_employee.id(1,1),'DEVICE-AUDIT-CONFLICT','Conflicting Code Holder','Active',null),
  (audit_device_employee.id(4,5),audit_device_employee.id(1,1),'HR-AUDIT-CONFLICT','Conflicting Metadata Holder','Active','{"device_emp_code":"DEVICE-AUDIT-CONFLICT"}'),
  (audit_device_employee.id(4,6),audit_device_employee.id(1,1),'HR-AUDIT-DUPLICATE','Existing Duplicate Person','Inactive',null),
  (audit_device_employee.id(4,7),audit_device_employee.id(1,1),'HR-AUDIT-SUGGESTION','Suggested Existing Person','Active',null),
  (audit_device_employee.id(4,8),audit_device_employee.id(1,1),'DEVICE-AUDIT-MULTICODE','First Company Code Holder','Active',null),
  (audit_device_employee.id(4,9),audit_device_employee.id(1,2),'DEVICE-AUDIT-MULTICODE','Second Company Code Holder','Active',null);

-- Historic UTC punches cross midnight in India; an already-owned punch must never move.
insert into public.raw_punches(emp_code,punch_time,employee_id) values
  ('DEVICE-AUDIT-NEW','2026-09-17 18:45:00+00',null),
  ('DEVICE-AUDIT-NEW','2026-09-24 20:00:00+00',null),
  ('DEVICE-AUDIT-NEW','2026-09-26 04:00:00+00',audit_device_employee.id(4,1));
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,department_name,area_name,position_name,hire_date,last_synced_at) values
  ('DEVICE-AUDIT-NEW','New Device Employee','Device Unique Department','Device audit branch','Unmapped Position','2026-09-01','2026-09-17 00:00:00+00');
reset role;
do $$ declare employee uuid; begin
  select employee_id into employee from public.biotime_employees where emp_code='DEVICE-AUDIT-NEW';
  assert employee is not null,'a trusted new named enrolment creates an HRMS employee';
  assert (select link_status='auto' and linked_at is not null and linked_by is null
    from public.biotime_employees where emp_code='DEVICE-AUDIT-NEW'),'new roster identity is automatically linked';
  assert (select employee_code='DEVICE-AUDIT-NEW' and full_name='New Device Employee'
    and entity_id=audit_device_employee.id(1,1) and status='Active' and join_date='2026-09-01'
    and department_id=audit_device_employee.id(3,1) and branch_id is null and designation_id is null and user_id is null
    and meta->>'source'='biotime' and meta->>'device_emp_code'='DEVICE-AUDIT-NEW'
    and (meta->>'needs_hr_review')::boolean from public.employees where id=employee),
    'provision exact device code, source metadata and unique department without guessing branch or login';
  assert (select count(*)=2 from public.raw_punches where emp_code='DEVICE-AUDIT-NEW' and employee_id=employee
    and entity_id=audit_device_employee.id(1,1) and department_id=audit_device_employee.id(3,1)),
    'orphan punches are adopted with employee ancestry';
  assert (select employee_id=audit_device_employee.id(4,1) from public.raw_punches
    where emp_code='DEVICE-AUDIT-NEW' and punch_time='2026-09-26 04:00:00+00'),'assigned punches keep their original owner';
  assert (select array_agg(work_date order by work_date)=array['2026-09-17','2026-09-18','2026-09-24','2026-09-25']::date[]
    from public.attendance_recompute_queue where employee_id=employee and processed_at is null),
    'adoption queues actual IST dates and their previous days, excluding unrelated dates and assigned punches';
end $$;

-- Simulate HR edits and an older worker clearing the link after an employee-code rename.
update public.employees set employee_code='HR-AUDIT-RENAMED',full_name='HR Reviewed Name',status='Inactive',
  branch_id=audit_device_employee.id(2,1),join_date='2025-01-01',phone='audit-private-number',
  meta=meta || '{"hr_note":"retained"}'::jsonb
where employee_code='DEVICE-AUDIT-NEW';
set local role service_role;
update public.biotime_employees set employee_id=null,link_status='unmatched',linked_at=null,
  full_name='Changed Device Name',hire_date='2026-09-12',last_synced_at='2026-09-18 00:00:00+00'
where emp_code='DEVICE-AUDIT-NEW';
update public.biotime_employees set last_synced_at='2026-09-19 00:00:00+00' where emp_code='DEVICE-AUDIT-NEW';
reset role;
do $$ begin
  assert (select be.link_status='auto' and e.full_name='HR Reviewed Name' and e.status='Inactive'
    and e.employee_code='HR-AUDIT-RENAMED' and e.branch_id=audit_device_employee.id(2,1)
    and e.join_date='2025-01-01' and e.phone='audit-private-number' and e.meta->>'hr_note'='retained'
    from public.biotime_employees be join public.employees e on e.id=be.employee_id where be.emp_code='DEVICE-AUDIT-NEW'),
    'refresh restores provisioned identity after legacy clearing and preserves every HR-maintained field';
  assert not exists(select from public.employees where employee_code='DEVICE-AUDIT-NEW'),'refresh does not duplicate a renamed employee';
  assert (select count(*)=4 and max(q.generation)=1 from public.attendance_recompute_queue q
    join public.biotime_employees be on be.employee_id=q.employee_id where be.emp_code='DEVICE-AUDIT-NEW'),
    'repeated roster refresh does not duplicate or churn recompute jobs';
end $$;

-- A transaction fetch can cache an unlinked code before the roster links it, then insert its
-- punch afterwards. A later ordinary roster refresh must recover that late orphan too.
insert into public.raw_punches(emp_code,punch_time) values ('DEVICE-AUDIT-NEW','2026-09-18 00:45:00+00');
set local role service_role;
update public.biotime_employees set last_synced_at='2026-09-20 00:00:00+00' where emp_code='DEVICE-AUDIT-NEW';
update public.biotime_employees set last_synced_at='2026-09-21 00:00:00+00' where emp_code='DEVICE-AUDIT-NEW';
reset role;
do $$ begin
  assert (select rp.employee_id=be.employee_id from public.raw_punches rp
    join public.biotime_employees be on be.emp_code=rp.emp_code
    where rp.emp_code='DEVICE-AUDIT-NEW' and rp.punch_time='2026-09-18 00:45:00+00'),
    'a same-identity trusted roster refresh adopts a punch inserted after initial linking';
  assert (select count(*)=4 and count(*)filter(where q.work_date in('2026-09-17','2026-09-18') and q.generation=2)=2
    and count(*)filter(where q.work_date in('2026-09-24','2026-09-25') and q.generation=1)=2
    from public.attendance_recompute_queue q join public.biotime_employees be on be.employee_id=q.employee_id
    where be.emp_code='DEVICE-AUDIT-NEW'),
    'late orphan bumps only its IST workday and previous day once; following no-op refresh preserves generations';
  assert (select employee_id=audit_device_employee.id(4,1) from public.raw_punches
    where emp_code='DEVICE-AUDIT-NEW' and punch_time='2026-09-26 04:00:00+00'),
    'late orphan recovery never reparents an already assigned punch';
end $$;

-- Exact code and stored device identity reuse inactive HR records; pending work gets a new generation.
insert into public.raw_punches(emp_code,punch_time) values ('DEVICE-AUDIT-EXACT','2026-09-17 18:45:00+00');
insert into public.attendance_recompute_queue(employee_id,work_date,reason,generation)
  values(audit_device_employee.id(4,2),'2026-09-18','Already in flight',7);
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,last_synced_at) values
  ('DEVICE-AUDIT-EXACT','Untrusted Replacement Name','2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-META','Untrusted Metadata Name','2026-09-17 00:00:00+00');
reset role;
do $$ begin
  assert (select employee_id=audit_device_employee.id(4,2) and link_status='auto'
    from public.biotime_employees where emp_code='DEVICE-AUDIT-EXACT'),'exact employee code reuses even inactive employee';
  assert (select employee_id=audit_device_employee.id(4,3) and link_status='auto'
    from public.biotime_employees where emp_code='DEVICE-AUDIT-META'),'device metadata identity reuses even inactive employee';
  assert (select full_name='HR Correct Legal Name' and status='Inactive' and meta='{"hr_note":"do not replace"}'::jsonb
    from public.employees where id=audit_device_employee.id(4,2)),'identity reuse does not reactivate or overwrite an HR record';
  assert (select generation=8 and processed_at is null from public.attendance_recompute_queue
    where employee_id=audit_device_employee.id(4,2) and work_date='2026-09-18'),'adoption invalidates an in-flight queue generation';
  assert exists(select from public.attendance_recompute_queue where employee_id=audit_device_employee.id(4,2)
    and work_date='2026-09-17' and processed_at is null),'previous overnight shift day is also queued';
end $$;

-- Device-only records and deliberate HR decisions do not turn into employees.
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,is_active,link_status,last_synced_at) values
  ('DEVICE-AUDIT-INACTIVE','Dormant Device Enrolment',false,'unmatched','2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-NAMELESS',E' \t\n',true,'unmatched','2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-ADMIN','Administrator',true,'unmatched','2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-IGNORED','Deliberately Ignored Visitor',true,'ignored','2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-MANUAL','Manual Decision Holder',true,'manual','2026-09-17 00:00:00+00');
insert into public.biotime_employees(emp_code,full_name,employee_id,link_status,last_synced_at) values
  ('DEVICE-AUDIT-PRESERVED','Mapped Identity Holder',audit_device_employee.id(4,1),'manual','2026-09-17 00:00:00+00');
update public.biotime_employees set employee_id=null,link_status='unmatched',last_synced_at='2026-09-18 00:00:00+00'
  where emp_code in('DEVICE-AUDIT-IGNORED','DEVICE-AUDIT-MANUAL','DEVICE-AUDIT-PRESERVED');
reset role;
do $$ begin
  assert not exists(select from public.employees where employee_code in('DEVICE-AUDIT-INACTIVE','DEVICE-AUDIT-NAMELESS',
    'DEVICE-AUDIT-ADMIN','DEVICE-AUDIT-IGNORED','DEVICE-AUDIT-MANUAL','DEVICE-AUDIT-PRESERVED')),
    'inactive, nameless, admin, ignored and manual enrolments are never auto-created';
  assert (select link_status='ignored' and employee_id is null from public.biotime_employees where emp_code='DEVICE-AUDIT-IGNORED'),
    'legacy worker cannot reset ignored decision';
  assert (select link_status='manual' and employee_id=audit_device_employee.id(4,1)
    from public.biotime_employees where emp_code='DEVICE-AUDIT-PRESERVED'),'legacy worker cannot clear manual mapping';
end $$;

-- Suspected duplicates stay in mapping review; no identity or company is guessed.
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,match_suggestions,last_synced_at) values
  ('DEVICE-AUDIT-DUPNAME','Existing.Duplicate Person',null,'2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-SUGGESTION','Potential New Spelling',jsonb_build_array(jsonb_build_object(
    'employee_id',audit_device_employee.id(4,7),'score',0.78,'reason','name')),'2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-CONFLICT','Conflicting Device Identity',null,'2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-MULTICODE','Repeated Across Companies',null,'2026-09-17 00:00:00+00');
reset role;
do $$ begin
  assert (select count(*)=4 and bool_and(employee_id is null and link_status='ambiguous')
    from public.biotime_employees where emp_code in('DEVICE-AUDIT-DUPNAME','DEVICE-AUDIT-SUGGESTION',
      'DEVICE-AUDIT-CONFLICT','DEVICE-AUDIT-MULTICODE')),'duplicate names, threshold suggestions and conflicting exact identities stay in review';
  assert not exists(select from public.employees where employee_code in('DEVICE-AUDIT-DUPNAME','DEVICE-AUDIT-SUGGESTION')),
    'review cases cannot silently duplicate employees';
end $$;

set local role service_role;
insert into public.biotime_employees(emp_code,full_name,department_name,last_synced_at) values
  ('DEVICE-AUDIT-DEPT-DUP','Department Duplicate Candidate','Device Duplicate Department','2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-DEPT-OLD','Department Retired Candidate','Device Retired Department','2026-09-17 00:00:00+00');
reset role;
do $$ begin
  assert (select count(*)=2 and bool_and(department_id is null and branch_id is null)
    from public.employees where employee_code in('DEVICE-AUDIT-DEPT-DUP','DEVICE-AUDIT-DEPT-OLD')),
    'ambiguous or inactive department names do not cause guessed organization assignments';
end $$;
update public.entities set is_active=true where id=audit_device_employee.id(1,2);
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,last_synced_at)
  values('DEVICE-AUDIT-MULTICOMPANY','Company Undetermined Candidate','2026-09-17 00:00:00+00');
reset role;
do $$ begin
  assert (select employee_id is null from public.biotime_employees where emp_code='DEVICE-AUDIT-MULTICOMPANY'),
    'multiple active companies leave new identity unresolved';
  assert not exists(select from public.employees where employee_code='DEVICE-AUDIT-MULTICOMPANY'),'company ambiguity creates no employee';
end $$;
update public.entities set is_active=false where id=audit_device_employee.id(1,2);

-- Only the roster-sync event provisions. Ordinary updates and authenticated users cannot trigger it.
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,is_active,last_synced_at) values
  ('DEVICE-AUDIT-REFRESH','Refresh Only Candidate',false,'2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-AUTH','Authenticated Candidate',false,'2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-AUTH-EMPTY','Empty User Context Candidate',false,'2026-09-17 00:00:00+00'),
  ('DEVICE-AUDIT-BACKFILL','Historic Backfill Candidate',false,'2026-09-17 00:00:00+00');
update public.biotime_employees set is_active=true
  where emp_code in('DEVICE-AUDIT-REFRESH','DEVICE-AUDIT-AUTH','DEVICE-AUDIT-AUTH-EMPTY','DEVICE-AUDIT-BACKFILL');
reset role;
do $$ begin
  assert not exists(select from public.employees where employee_code in('DEVICE-AUDIT-REFRESH','DEVICE-AUDIT-AUTH','DEVICE-AUDIT-AUTH-EMPTY','DEVICE-AUDIT-BACKFILL')),
    'editing roster flags without new sync timestamp does not provision';
end $$;
-- Installing or reinstalling the migration must not touch eligible historical data.
\ir ../supabase/migrations/0147_auto_provision_device_employees.sql
do $$ begin
  assert not exists(select from public.employees where employee_code in('DEVICE-AUDIT-REFRESH','DEVICE-AUDIT-AUTH','DEVICE-AUDIT-AUTH-EMPTY','DEVICE-AUDIT-BACKFILL')),
    'migration rerun installs triggers without provisioning historical rows';
end $$;
insert into auth.users(id,email) values(audit_device_employee.id(5,1),'device-provision-admin@audit.invalid');
update public.profiles set is_super_admin=true where user_id=audit_device_employee.id(5,1);
set local role authenticated;
set local request.jwt.claim.sub='d4700005-0000-0000-0000-000000000001';
set local app.provision_device_backfill='on';
update public.biotime_employees set last_synced_at='2026-09-18 00:00:00+00' where emp_code='DEVICE-AUDIT-AUTH';
reset role;
-- Isolate the trigger's role check from the restrictive active-account policy in this rollback fixture.
alter table public.biotime_employees disable row level security;
set local role authenticated;
set local request.jwt.claim.sub='';
update public.biotime_employees set last_synced_at='2026-09-18 00:00:00+00' where emp_code='DEVICE-AUDIT-AUTH-EMPTY';
reset role;
alter table public.biotime_employees enable row level security;
set local app.provision_device_backfill='off';
do $$ begin
  assert (select count(*)=2 and bool_and(employee_id is null and last_synced_at='2026-09-18 00:00:00+00')
    from public.biotime_employees where emp_code in('DEVICE-AUDIT-AUTH','DEVICE-AUDIT-AUTH-EMPTY')),
    'authenticated updates really execute but cannot provision, even with an empty JWT subject';
  assert not exists(select from public.employees where employee_code in('DEVICE-AUDIT-AUTH','DEVICE-AUDIT-AUTH-EMPTY')),
    'security-definer trigger is not a browser employee-creation bypass';
end $$;
set local role service_role;
update public.biotime_employees set last_synced_at='2026-09-19 00:00:00+00' where emp_code='DEVICE-AUDIT-REFRESH';
reset role;
do $$ begin
  assert exists(select from public.biotime_employees be join public.employees e on e.id=be.employee_id
    where be.emp_code='DEVICE-AUDIT-REFRESH' and e.employee_code=be.emp_code and be.link_status='auto'),
    'the next trusted roster refresh provisions an existing eligible enrolment';
end $$;
insert into public.raw_punches(emp_code,punch_time) values('DEVICE-AUDIT-BACKFILL','2026-09-17 18:45:00+00');
set local role service_role;
set local app.provision_device_backfill='on';
update public.biotime_employees set link_status=link_status where emp_code='DEVICE-AUDIT-BACKFILL';
reset role;
set local app.provision_device_backfill='off';
do $$ begin
  assert (select be.employee_id is not null and be.link_status='auto' and be.last_synced_at='2026-09-17 00:00:00+00'
    from public.biotime_employees be where be.emp_code='DEVICE-AUDIT-BACKFILL'),
    'trusted explicit backfill provisions without pretending the source just synced';
  assert (select rp.employee_id=be.employee_id from public.raw_punches rp join public.biotime_employees be on be.emp_code=rp.emp_code
    where be.emp_code='DEVICE-AUDIT-BACKFILL'),'explicit backfill adopts orphan punches';
  assert (select count(*)=2 from public.attendance_recompute_queue q join public.biotime_employees be on be.employee_id=q.employee_id
    where be.emp_code='DEVICE-AUDIT-BACKFILL' and q.processed_at is null),'explicit backfill queues both affected workdays';
end $$;
rollback;
select 'PASS: device employee creation, HR identity preservation, duplicate review, trusted-sync gate, orphan punch adoption and overnight generation-safe recomputes' as result;
