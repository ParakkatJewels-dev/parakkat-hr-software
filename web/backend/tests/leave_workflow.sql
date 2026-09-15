\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable role audit database required'; end if;
end $$;
create function audit_test.leave_expect_failure(statement text, expected_state text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % failure: %', expected_state, statement;
end $$;
grant execute on function audit_test.leave_expect_failure(text,text) to authenticated,anon;
reset role;
set request.jwt.claim.sub = '';
insert into public.leave_types(code,name,annual_quota,is_paid,deducts_balance) values ('AUDWF','Workflow audit leave',12,true,true);
-- A second head proves that the first head's own request still goes directly to HR.
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_test.id(7,1),id,'department',audit_test.id(4,1) from public.roles where key='dept_head';
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000007';
insert into public.leaves(id,employee_id,type,start_date,end_date,days,reason)
  values (audit_test.id(8,101),audit_test.id(5,107),'AUDWF','2030-01-02','2030-01-02',1,'Two-stage approval');
do $$ begin
  assert (select status='Pending' and approval_stage='department' from public.leaves where id=audit_test.id(8,101)), 'employee leave starts with the department head';
  assert not (select public.leave_can_decide(l) from public.leaves l where id=audit_test.id(8,101)), 'applicant cannot review own request';
  assert not has_function_privilege('anon','public.decide_leave(uuid,text,text)','execute'), 'anonymous cannot decide leave';
end $$;
select audit_test.leave_expect_failure($q$update public.leaves set status='Approved' where id=audit_test.id(8,101)$q$,'42501');
select audit_test.leave_expect_failure($q$insert into public.leaves(employee_id,type,start_date,end_date,status) values (audit_test.id(5,107),'AUDWF','2030-01-03','2030-01-03','Approved')$q$,'42501');
select audit_test.leave_expect_failure($q$insert into public.leaves(employee_id,type,start_date,end_date,approval_stage) values (audit_test.id(5,107),'AUDWF','2030-01-03','2030-01-03','hr')$q$,'42501');
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','I approve my own request')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','Skip department review')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','Administrator skips department')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000005';
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','Branch manager is not department head')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','   ')$q$,'22023');
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved',E' \n\t ')$q$,'22023');
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved',repeat('x',2001))$q$,'22023');
select public.decide_leave(audit_test.id(8,101),'On Hold','Confirm coverage for the day');
select public.decide_leave(audit_test.id(8,101),'Pending','Coverage confirmed; resuming review');
select public.decide_leave(audit_test.id(8,101),'Approved','  Coverage arranged by the department  ');
do $$ begin
  assert (select status='Pending' and approval_stage='hr' and decided_at is null from public.leaves where id=audit_test.id(8,101)), 'department approval forwards Pending leave without final sanction metadata';
  assert not (select public.leave_can_decide(l) from public.leaves l where id=audit_test.id(8,101)), 'department cannot issue HR decision';
  assert (select count(*)=3 from public.leave_decisions where leave_id=audit_test.id(8,101)), 'holds, resumptions and department approval are retained';
  assert exists(select 1 from public.leave_decisions where leave_id=audit_test.id(8,101) and stage='department' and decision='Approved'
    and remarks='Coverage arranged by the department' and actor_user_id=audit_test.id(6,6) and actor_employee_id=audit_test.id(5,106)
    and actor_name='Audit dept_head' and from_status='Pending' and to_status='Pending' and from_stage='department' and to_stage='hr'), 'decision history has actor, trimmed remarks and transition';
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from public.leave_balances b join public.leave_types t on t.id=b.leave_type_id where b.employee_id=audit_test.id(5,107) and t.code='AUDWF' and b.used>0), 'department approval does not deduct leave balance';
  assert not exists(select 1 from public.notifications where ref_id=audit_test.id(8,101) and type='leave' and user_id=audit_test.id(6,6) and read_at is null), 'department notification clears after forwarding';
  assert exists(select 1 from public.notifications where ref_id=audit_test.id(8,101) and type='leave' and user_id=audit_test.id(6,3) and read_at is null), 'HR is notified when sanction is due';
  assert not exists(select 1 from public.notifications where ref_id=audit_test.id(8,101) and type='leave' and user_id=audit_test.id(6,5) and read_at is null), 'branch manager receives no approval action';
end $$;
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select public.decide_leave(audit_test.id(8,101),'Approved','HR sanction granted');
do $$ begin
  assert (select status='Approved' and approval_stage='completed' and decided_by=audit_test.id(6,3) and approver_id=audit_test.id(5,103) from public.leaves where id=audit_test.id(8,101)), 'HR approval sets final Approved status';
  assert (select count(*)=4 from public.leave_decisions where leave_id=audit_test.id(8,101)), 'HR decision appends history';
end $$;
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','Duplicate sanction')$q$,'22023');
select audit_test.leave_expect_failure($q$update public.leave_decisions set remarks='Rewritten history' where leave_id=audit_test.id(8,101)$q$,'42501');
select audit_test.leave_expect_failure($q$delete from public.leave_decisions where leave_id=audit_test.id(8,101)$q$,'42501');
select audit_test.leave_expect_failure($q$delete from public.leaves where id=audit_test.id(8,101)$q$,'42501');
reset role;
do $$ begin
  assert (select b.used=1 from public.leave_balances b join public.leave_types t on t.id=b.leave_type_id where b.employee_id=audit_test.id(5,107) and t.code='AUDWF' and b.year=2030), 'HR approval deducts one day exactly once';
end $$;
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000007';
do $$ begin
  assert (select count(*)=4 from public.leave_decisions where leave_id=audit_test.id(8,101)), 'applicant can read both stages and remarks';
end $$;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000008';
do $$ begin
  assert not exists(select 1 from public.leave_decisions where leave_id=audit_test.id(8,101)), 'unassigned account cannot read another employee history';
end $$;
select 'PASS: department-to-HR review, strict roles, required remarks, immutable scoped history and final-only balance deduction' as result;

-- HR may reopen; a settled rejection/cancellation cannot jump straight to sanction.
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select public.decide_leave(audit_test.id(8,101),'Pending','Dates need another department review');
reset role;
do $$ begin
  assert (select status='Pending' and approval_stage='department' from public.leaves where id=audit_test.id(8,101)), 'reopening starts department-first cycle';
  assert (select b.used=0 from public.leave_balances b join public.leave_types t on t.id=b.leave_type_id where b.employee_id=audit_test.id(5,107) and t.code='AUDWF' and b.year=2030), 'reopening releases sanctioned balance';
end $$;
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
select public.decide_leave(audit_test.id(8,101),'Rejected','Coverage is no longer available');
do $$ begin
  assert (select status='Rejected' and approval_stage='completed' from public.leaves where id=audit_test.id(8,101)), 'department can reject before HR';
end $$;
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Pending','Department reopens final decision')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,101),'Approved','Skip fresh department review')$q$,'22023');
select public.decide_leave(audit_test.id(8,101),'Pending','Reassess the request');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
select public.decide_leave(audit_test.id(8,101),'Approved','Department approves on reassessment');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select public.decide_leave(audit_test.id(8,101),'Rejected','HR policy does not permit the leave');
do $$ begin
  assert (select count(*)=9 from public.leave_decisions where leave_id=audit_test.id(8,101)), 'reopens and both rejection stages preserve full history';
end $$;
select 'PASS: department and HR rejection, HR-only reopening, review cycles and restored balances' as result;

set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
insert into public.leaves(id,employee_id,type,start_date,end_date,days,reason)
  values (audit_test.id(8,102),audit_test.id(5,106),'AUDWF','2030-01-03','2030-01-03',1,'Head own request');
do $$ begin
  assert (select approval_stage='hr' from public.leaves where id=audit_test.id(8,102)), 'head own leave goes to HR even with another head';
end $$;
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,102),'Approved','Self approve as head')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
insert into public.leaves(id,employee_id,type,start_date,end_date,days,reason)
  values (audit_test.id(8,105),audit_test.id(5,103),'AUDWF','2030-01-03','2030-01-03',1,'HR own request');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000006';
select public.decide_leave(audit_test.id(8,105),'Approved','Department reviews HR employee leave');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,105),'Approved','HR sanctions their own request')$q$,'42501');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
select public.decide_leave(audit_test.id(8,105),'Approved','Independent administrator sanction for HR employee');
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
insert into public.leaves(id,employee_id,type,start_date,end_date,days,reason)
  values (audit_test.id(8,103),audit_test.id(5,101),'AUDWF','2030-01-03','2030-01-03',1,'Admin own request');
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,103),'Approved','Self approve as super admin')$q$,'42501');
reset role;
set request.jwt.claim.sub = '';
insert into public.leaves(id,employee_id,type,start_date,end_date,days,reason)
  values (audit_test.id(8,104),audit_test.id(5,2),'AUDWF','2030-01-03','2030-01-03',1,'No head department');
do $$ begin
  assert (select approval_stage='hr' from public.leaves where id=audit_test.id(8,104)), 'department with no eligible head routes to HR';
end $$;
-- Departing heads cannot strand existing pending requests.
delete from public.role_assignments where role_id=(select id from public.roles where key='dept_head');
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
do $$ begin
  assert (select public.leave_effective_stage(l)='hr' and public.leave_can_decide(l) from public.leaves l where id=audit_test.id(8,103)), 'HR takes over after the head role is removed';
end $$;
select public.decide_leave(audit_test.id(8,103),'On Hold','HR needs additional details after the head departed');
reset role;
do $$ begin
  assert not exists(select 1 from public.notifications where ref_id=audit_test.id(8,103)
    and user_id=audit_test.id(6,1) and title='Department approved; awaiting HR sanction'), 'HR fallback must not claim a nonexistent department approval';
end $$;
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
select public.decide_leave(audit_test.id(8,103),'Approved','HR fallback because head role is vacant');
select public.decide_leave(audit_test.id(8,104),'Approved','HR fallback with no head');
select public.decide_leave(audit_test.id(8,102),'Approved','Independent HR review of head request');
select 'PASS: head own requests, missing/departed heads, admin self-review prohibition and HR fallback' as result;

-- Preserve automatic attendance cancellation and finalized payroll locks.
reset role;
set request.jwt.claim.sub = '';
insert into public.attendance(employee_id,work_date,status,is_locked)
  values (audit_test.id(5,2),'2030-01-03','On Leave',true);
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
do $$ begin
  assert not (select public.leave_can_reopen(l) from public.leaves l where id=audit_test.id(8,104)), 'payroll-locked leave exposes no reopen/cancel capability';
end $$;
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,104),'Cancelled','Cancel payroll-locked leave')$q$,'55000');
reset role;
set request.jwt.claim.sub = '';
select app.cancel_leave_day_for_punch(audit_test.id(8,102),'2030-01-03');
do $$ begin
  assert (select status='Cancelled' and approval_stage='completed' and days=0 from public.leaves where id=audit_test.id(8,102)), 'attendance cancellation keeps completed workflow with zero days';
end $$;
set role authenticated;
set request.jwt.claim.sub = '60000000-0000-0000-0000-000000000003';
do $$ begin
  assert not (select public.leave_can_reopen(l) from public.leaves l where id=audit_test.id(8,102)), 'fully attendance-cancelled leave does not offer an impossible reopen action';
end $$;
select audit_test.leave_expect_failure($q$select public.decide_leave(audit_test.id(8,102),'Pending','Reopen fully punched leave')$q$,'22023');
reset role;
set request.jwt.claim.sub = '';
select 'PASS: payroll locks and automatic punch cancellations remain protected by staged leave workflow' as result;
