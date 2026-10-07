-- Synthetic salary arithmetic, exercised only after migrations in a disposable cluster.
\set ON_ERROR_STOP on
do $$ begin
  if current_database()<>'hr_payroll_integrity_audit' then raise exception 'Disposable payroll integrity database required'; end if;
end $$;
reset role;
set request.jwt.claim.sub='';
begin;
insert into public.entities(id,code,name)
 select register_test.id(1,n),'SHIFT-PAY-'||n,'Shift salary fixture '||n from generate_series(301,307)n;
-- New entities receive a GEN default automatically; these fixtures explicitly configure their
-- own rates below, and305 intentionally exercises the shared fallback followed by no fallback.
update public.shifts set is_default=false
 where entity_id in (select register_test.id(1,n) from generate_series(301,307)n);
insert into public.branches(id,entity_id,code,name)
 select register_test.id(2,n),register_test.id(1,n),'SHIFT-PAY-B'||n,'Shift salary branch '||n from generate_series(301,307)n;
insert into auth.users(id,email) values(register_test.id(3,301),'shift-payroll@audit.invalid');
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
 select register_test.id(3,301),(select id from public.roles where key='hr_manager'),'entity',register_test.id(1,n)
 from generate_series(301,307)n;
insert into public.employees(id,entity_id,branch_id,employee_code,full_name,status,join_date)
 select register_test.id(4,n),register_test.id(1,n),register_test.id(2,n),'SHIFT-PAY-'||n,
   'Synthetic shift salary employee '||n,case when n=307 then 'Inactive' else 'Active' end,
   case when n=306 then '2030-09-16'::date else '2030-01-01'::date end
 from generate_series(301,307)n;
insert into public.exits(employee_id,last_day,status) values(register_test.id(4,307),'2030-09-15','Completed');
insert into public.salary_structures(employee_id,effective_from,basic,gross)
 select register_test.id(4,n),case when n=306 then '2030-09-16'::date else '2030-01-01'::date end,30000,30000
 from generate_series(301,307)n;
insert into public.shifts(id,entity_id,code,name,start_time,end_time,break_minutes,break_policy,
 full_day_minutes,half_day_minutes,is_default)
 select register_test.id(9,n),register_test.id(1,n),'DAY-'||n,'Eight and half hour fixture',
   '09:00','17:30',0,'actual',510,255,true from generate_series(301,307)n where n not in (303,305);
insert into public.shifts(id,entity_id,code,name,start_time,end_time,break_minutes,break_policy,
 full_day_minutes,half_day_minutes,is_default)
 select register_test.id(10,n),register_test.id(1,n),'NIGHT-'||n,'Eight hour night fixture',
   '22:00','06:00',0,'actual',480,240,n=303 from generate_series(301,307)n where n<>305;
insert into public.employee_shift_assignments(employee_id,shift_id,effective_from)
 select register_test.id(4,n),register_test.id(10,n),'2030-09-16' from generate_series(301,307)n where n not in (303,305);
set constraints all immediate;
update public.shifts set is_active=false where id=register_test.id(10,301);
-- All historical work is deliberately synthetic. Assignment queue rows are acknowledged only
-- after the matching attendance fixture has been supplied, as a completed worker run would do.
insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
 select register_test.id(4,n),d::date,'Absent',0,'working',0,clock_timestamp()
 from generate_series(301,302)n cross join generate_series('2030-09-01'::date,'2030-09-30'::date,'1 day')d;
update public.attendance a set status=v.status,day_fraction=v.fraction,day_type=v.day_type,
 worked_minutes=v.minutes,leave_type=v.leave_type
 from (values
   ('2030-09-01'::date,'Present',1::numeric,'working',510,null::text),
   ('2030-09-02'::date,'Half Day',0.5,'working',255,null),
   ('2030-09-03'::date,'Holiday',1,'holiday',0,null),
   ('2030-09-04'::date,'Weekly Off',1,'weekly_off',0,null),
   ('2030-09-05'::date,'On Leave',1,'working',0,'CL'),
   ('2030-09-06'::date,'On Leave',0.5,'working',0,'SL'),
   ('2030-09-16'::date,'Present',1,'working',480,null),
   ('2030-09-17'::date,'Half Day',0.5,'working',240,null),
   ('2030-09-18'::date,'Holiday',1,'holiday',0,null),
   ('2030-09-19'::date,'Weekly Off',1,'weekly_off',0,null),
   ('2030-09-20'::date,'On Leave',0.5,'working',0,'CL'),
   ('2030-09-21'::date,'On Leave',1,'working',0,'SL')
 )v(day,status,fraction,day_type,minutes,leave_type)
 where a.employee_id=register_test.id(4,301) and a.work_date=v.day;
update public.attendance set status='Present',day_fraction=1,
 worked_minutes=case when work_date<'2030-09-16' then 510 else 480 end
 where employee_id=register_test.id(4,302) and work_date<='2030-09-22';
update public.attendance set status='Holiday',day_fraction=1,day_type='holiday'
 where employee_id=register_test.id(4,302) and work_date='2030-09-24';
update public.attendance set status='On Leave',day_fraction=1,leave_type='SL'
 where employee_id=register_test.id(4,302) and work_date='2030-09-25';
update public.attendance_recompute_queue set processed_at=clock_timestamp()
 where employee_id in (select register_test.id(4,n) from generate_series(301,307)n);

select hourly_test.expect('shift/effective assignments retain inactive historical night definitions',
 (select jsonb_agg(jsonb_build_array(work_date,daily_minutes) order by work_date)
 from app.payroll_shift_days(register_test.id(4,301),'2030-09-15','2030-09-16')),
 '[["2030-09-15",510],["2030-09-16",480]]');
select hourly_test.expect('shift/dated worked and paid credits retain fractional leave without duplication',
 (select jsonb_build_array(sum(worked_minutes),sum(actual),sum(holiday),sum(off_day),sum(casual),sum(other_leave))
 from app.payroll_shift_days(register_test.id(4,301),'2030-09-01','2030-09-30')),
 '[1485,3,2,2,1.5,1.5]');
select hourly_test.expect('shift/global default remains an explicit shift fallback',
 to_jsonb(public.shift_for_employee(register_test.id(4,305),'2030-09-01')=
   (select id from public.shifts where entity_id is null and is_active and is_default)), 'true');

set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,301)::text,false);
select hourly_test.policy(n,'{"calculation_mode":"hourly_workings","credit_mode":"earned","hours_per_day":8.5}')
 from generate_series(301,307)n;
select hourly_test.policy(301,'{"credit_mode":"attendance"}');
select public.run_payroll(register_test.id(1,301),'2030-09');
-- Independent arithmetic: 1.5 day duties ×8.5h×117.6 +1.5 night duties ×8h×125
-- +3.5 dated credits at each basis =1499.4+1500+3498.6+3500 =9998.
select hourly_test.expect('shift/mixed dated attendance prices each worked and credited date',hourly_test.money(301,'2030-09'),'[9998,0,9998]');
select hourly_test.expect('shift/mixed rate snapshot has no invented single daily or hourly rate',
 (select jsonb_build_array(payroll_register->'variable_shift_hours',payroll_register->'per_day_working_hour',
   payroll_register->'per_hour_wages',payroll_register->'worked_hours',payroll_register->'credited_hours',
   payroll_register->'required_worked_hours',payroll_register->'undated_credit_days')
 from public.payslips where employee_id=register_test.id(4,301) and period='2030-09'),
 '[true,null,null,24.75,57.75,24.75,0]');
select hourly_test.expect('shift/date audit explains both hourly rates and dated leave money',
 (select jsonb_agg(jsonb_build_array(d->>'work_date',d->'daily_hours',d->'hourly_rate',d->'worked_amount',d->'credit_amount') order by d->>'work_date')
 from public.payslips p cross join lateral jsonb_array_elements(p.payroll_register->'shift_days')d
 where p.employee_id=register_test.id(4,301) and p.period='2030-09' and d->>'work_date' in ('2030-09-01','2030-09-06','2030-09-16','2030-09-20')),
 '[["2030-09-01",8.5,117.6,999.6,0],["2030-09-06",8.5,117.6,0,499.8],["2030-09-16",8,125,1000,0],["2030-09-20",8,125,0,500]]');
select hourly_test.policy(301,'{"credit_mode":"earned"}');
select public.run_payroll(register_test.id(1,301),'2030-09');
select hourly_test.expect('shift/earned mode removes dated CL and offs without removing other paid leave',hourly_test.money(301,'2030-09'),'[6499,0,6499]');
select hourly_test.save(301,'2030-09','{"off_days":1.5,"casual_leave_days":0.5,"notes":"Approved total credits across changed daily shift basis"}');
select public.run_payroll(register_test.id(1,301),'2030-09');
select hourly_test.expect('shift/undated override credits use one daily wage per day',hourly_test.money(301,'2030-09'),'[8499,0,8499]');
select hourly_test.expect('shift/undated credits remain money instead of fabricated hours',
 (select jsonb_build_array(payroll_register->'credited_hours',payroll_register->'undated_credit_days',
   payroll_register->'undated_credit_amount',payroll_register->'unrounded_earned_salary')
 from public.payslips where employee_id=register_test.id(4,301) and period='2030-09'), '[28.75,2,2000,8498.8]');
select hourly_test.save(301,'2030-09','{"off_days":0,"casual_leave_days":0}');
select public.run_payroll(register_test.id(1,301),'2030-09');
select hourly_test.expect('shift/explicit zero credit override is retained',hourly_test.money(301,'2030-09'),'[6499,0,6499]');
select hourly_test.save(301,'2030-09','{"off_days":null,"casual_leave_days":null}');
select hourly_test.policy(301,'{"credit_mode":"attendance"}');
select public.run_payroll(register_test.id(1,301),'2030-09');
select hourly_test.expect('shift/clearing overrides restores dated recorded credits',hourly_test.money(301,'2030-09'),'[9998,0,9998]');

select public.run_payroll(register_test.id(1,302),'2030-09');
-- 15×999.6 +7×1000 worked; two dated paid days ×1000; earned CL1 +offs3 ×1000.
select hourly_test.expect('shift/earned off and casual credits use daily wages across different shifts',hourly_test.money(302,'2030-09'),'[27994,0,27994]');
select hourly_test.expect('shift/earned credit trace exposes four undated days and preserves dated holiday and other leave',
 (select jsonb_build_array(payroll_register->'actual_working_days',payroll_register->'casual_leave',payroll_register->'off_days',
   payroll_register->'undated_credit_days',payroll_register->'undated_credit_amount',payroll_register->'credited_hours')
 from public.payslips where employee_id=register_test.id(4,302) and period='2030-09'), '[22,1,3,4,4000,16]');
select hourly_test.expect('shift/mixed earnings reconcile to payslip lines',
 (select jsonb_build_array(sum(l.amount) filter(where l.kind='earning'),coalesce(sum(l.amount) filter(where l.kind='deduction'),0))
 from public.payslips p join public.payslip_lines l on l.payslip_id=p.id
 where p.employee_id=register_test.id(4,302) and p.period='2030-09'), '[27994,0]');

select hourly_test.save(303,'2030-09','{"attendance_source":"reviewed","worked_minutes":9600,"actual_working_days":20,"public_holiday_days":1,"notes":"Reviewed register for uniform eight hour assigned shifts"}');
select public.run_payroll(register_test.id(1,303),'2030-09');
select hourly_test.expect('shift/uniform reviewed hours use assigned eight hours despite company eight-and-half default',hourly_test.money(303,'2030-09'),'[25000,0,25000]');
select hourly_test.expect('shift/uniform reviewed readiness can bypass missing device records',
 (select jsonb_build_array(s->'reviewed_source_ready',s->'recorded_missing_days',s->'daily_shift_hours',s->'variable_shift_hours')
 from (select hourly_test.summary(303,303,'2030-09')s)x), '[true,30,8,false]');
select hourly_test.save(304,'2030-09','{"attendance_source":"reviewed","worked_minutes":9600,"actual_working_days":20,"public_holiday_days":1,"notes":"Monthly aggregate lacks daily split for changed shifts"}');
select hourly_test.expect('shift/mixed reviewed aggregates cannot claim readiness',
 (select jsonb_build_array(s->'reviewed_source_ready',s->'missing_days',to_jsonb((s->>'attendance_review_issue') like 'Daily shift hours change%'))
 from (select hourly_test.summary(304,304,'2030-09')s)x), '[false,30,true]');
select hourly_test.expect('shift/mixed reviewed aggregates block payroll rather than selecting a rate',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,304),'2030-09')$q$)), '"23514"');
select hourly_test.expect('shift/blocked aggregate calculation leaves no partial payslip',
 (select to_jsonb(count(*)) from public.payslips where employee_id=register_test.id(4,304) and period='2030-09'), '0');

select hourly_test.save(306,'2030-09','{"attendance_source":"reviewed","worked_minutes":4800,"actual_working_days":10,"public_holiday_days":0,"notes":"Joiner starts with night duty on16September"}');
select public.run_payroll(register_test.id(1,306),'2030-09');
select hourly_test.expect('shift/joiner ignores the different default before employment',hourly_test.money(306,'2030-09'),'[11000,0,11000]');
select hourly_test.save(307,'2030-09','{"attendance_source":"reviewed","worked_minutes":5100,"actual_working_days":10,"public_holiday_days":0,"notes":"Completed leaver uses day duty through15September"}');
select public.run_payroll(register_test.id(1,307),'2030-09');
select hourly_test.expect('shift/leaver ignores the changed shift after employment and preserves HR hourly rounding',hourly_test.money(307,'2030-09'),'[10996,0,10996]');

-- Privileged tampering models damaged stored snapshots; publication must recompute the source.
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{shift_days,0,hourly_rate}','1')
 where employee_id=register_test.id(4,301) and period='2030-09';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,301)::text,false);
select hourly_test.expect('shift/publication rejects a corrupted per-date rate trace',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(301,'2030-09'))$q$)), '"23514"');
select public.run_payroll(register_test.id(1,301),'2030-09');
reset role;
set request.jwt.claim.sub='';
update public.payslips set payroll_register=jsonb_set(payroll_register,'{shift_days}',
  (payroll_register->'shift_days')||jsonb_build_array(payroll_register#>'{shift_days,0}'))
 where employee_id=register_test.id(4,301) and period='2030-09';
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,301)::text,false);
select hourly_test.expect('shift/publication rejects an extra duplicated date even when all valid dates remain',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(301,'2030-09'))$q$)), '"23514"');
select public.run_payroll(register_test.id(1,301),'2030-09');
select register_test.publish(hourly_test.run_id(301,'2030-09'));
select register_test.publish(hourly_test.run_id(303,'2030-09'));
select hourly_test.expect('shift/valid mixed recorded and uniform reviewed drafts publish',
 (select jsonb_agg(status order by employee_id) from public.payslips
 where employee_id in (register_test.id(4,301),register_test.id(4,303)) and period='2030-09'), '["Published","Published"]');
select hourly_test.expect('shift/published mixed payroll locks its complete employment interval',
 (select to_jsonb(count(*)) from public.attendance where employee_id=register_test.id(4,301) and work_date between '2030-09-01' and '2030-09-30' and is_locked), '30');

reset role;
set request.jwt.claim.sub='';
update public.shifts set full_day_minutes=480 where id=register_test.id(9,302);
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,301)::text,false);
select hourly_test.expect('shift/changing a daily salary basis invalidates the existing draft',
 (select to_jsonb(needs_recalculation) from public.payroll_runs where id=hourly_test.run_id(302,'2030-09')), 'true');
select hourly_test.expect('shift/publication rejects stale money after a shift basis change',
 to_jsonb(hourly_test.error($q$select register_test.publish(hourly_test.run_id(302,'2030-09'))$q$)), '"55000"');

-- Remove only the shared fallback inside this rolled-back fixture transaction. No company or
-- assignment exists for305, so hours must not silently fall back to a payroll policy constant.
reset role;
set request.jwt.claim.sub='';
update public.shifts set is_active=false where entity_id is null and is_default;
select hourly_test.expect('shift/missing assignment and fallback produce an actionable basis issue',
 to_jsonb(app.payroll_shift_basis_issue(register_test.id(4,305),'2030-09-01','2030-09-30','{}') like 'Assign a shift%'), 'true');
set role authenticated;
select set_config('request.jwt.claim.sub',register_test.id(3,301)::text,false);
select hourly_test.save(305,'2030-09','{"attendance_source":"reviewed","worked_minutes":9600,"actual_working_days":20,"public_holiday_days":1,"notes":"Reviewed hours still require an assigned salary basis"}');
select hourly_test.expect('shift/missing basis blocks reviewed readiness',
 (select jsonb_build_array(s->'reviewed_source_ready',to_jsonb((s->>'attendance_review_issue') like 'Assign a shift%'))
 from (select hourly_test.summary(305,305,'2030-09')s)x), '[false,true]');
select hourly_test.expect('shift/missing basis blocks generation',
 to_jsonb(hourly_test.error($q$select public.run_payroll(register_test.id(1,305),'2030-09')$q$)), '"23514"');
reset role;
set request.jwt.claim.sub='';
select 'PASS: assigned-shift payroll '||count(*)||' assertions; date-specific wages and leave credits, earned undated credits, overrides, reviewed-source limits, employment windows, reconciliation and publication guards'
 from hourly_test.results where label like 'shift/%';
rollback;
