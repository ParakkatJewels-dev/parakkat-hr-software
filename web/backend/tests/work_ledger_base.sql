-- Work Ledger base: the disposable database's people and helpers, the date rules, and reminders with
-- Google Calendar (0169-0170, still in use). The task, creative and import tests (work_tasks.sql,
-- work_creative.sql, work_import.sql) run after this file and reuse its people. Synthetic data only.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_work_ledger_audit' then raise exception 'requires disposable hr_work_ledger_audit database'; end if;
end $$;

create schema audit_ledger;
create function audit_ledger.id(prefix integer, n integer) returns uuid language sql immutable as $$
  select (prefix::text || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create function audit_ledger.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate <> expected_code then raise; end if;
    return;
  end;
  raise exception 'Expected SQLSTATE %', expected_code;
end $$;
create function audit_ledger.as_user(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', audit_ledger.id(6, n)::text, false);
end $$;
grant usage on schema audit_ledger to authenticated, anon;
grant execute on all functions in schema audit_ledger to authenticated, anon;

-- Company 1 has departments A (4,1) and B (4,2) in branch 3,1; company 2 is elsewhere.
insert into public.entities(id, code, name) select audit_ledger.id(1,n), 'LED-ENT-'||n, 'Ledger company '||n from generate_series(1,2)n;
insert into public.zones(id, entity_id, code, name) select audit_ledger.id(2,n), audit_ledger.id(1,n), 'LED-ZONE-'||n, 'Ledger zone '||n from generate_series(1,2)n;
insert into public.branches(id, entity_id, zone_id, code, name, address)
  select audit_ledger.id(3,n), audit_ledger.id(1,n), audit_ledger.id(2,n), 'LED-BR-'||n, 'Ledger branch '||n, 'Address' from generate_series(1,2)n;
insert into public.departments(id, entity_id, branch_id, code, name) values
  (audit_ledger.id(4,1), audit_ledger.id(1,1), audit_ledger.id(3,1), 'LED-A', 'Creative'),
  (audit_ledger.id(4,2), audit_ledger.id(1,1), audit_ledger.id(3,1), 'LED-B', 'Sales'),
  (audit_ledger.id(4,3), audit_ledger.id(1,2), audit_ledger.id(3,2), 'LED-C', 'Elsewhere');
-- 1 owner (employee, dept A)      2 peer (employee, dept A)      3 head of dept A
-- 4 head of dept B                5 branch manager of branch 1   6 entity admin of company 1
-- 7 HR manager of company 1       8 super admin (profile flag)   9 entity admin of company 2
-- 10 second head of dept A (peer rank of an owner who is a head)
insert into auth.users(id, email) select audit_ledger.id(6,n), 'ledger-'||n||'@audit.invalid' from generate_series(1,10)n;
insert into public.employees(id, entity_id, branch_id, department_id, full_name, employee_code, email, join_date)
  select audit_ledger.id(7,n), audit_ledger.id(1, case when n = 9 then 2 else 1 end), audit_ledger.id(3, case when n = 9 then 2 else 1 end),
    audit_ledger.id(4, case when n in (4) then 2 when n = 9 then 3 else 1 end), 'Ledger Person '||n, 'LED-'||n, 'p'||n||'@audit.invalid', '2026-01-01'
  from generate_series(1,10)n;
update public.profiles p set employee_id = audit_ledger.id(7, n) from generate_series(1,10)n where p.user_id = audit_ledger.id(6, n);
update public.profiles set is_super_admin = true where user_id = audit_ledger.id(6,8);
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
  select audit_ledger.id(6,3), id, 'department'::scope_type, audit_ledger.id(4,1) from public.roles where key = 'dept_head'
  union all select audit_ledger.id(6,4), id, 'department'::scope_type, audit_ledger.id(4,2) from public.roles where key = 'dept_head'
  union all select audit_ledger.id(6,5), id, 'branch'::scope_type, audit_ledger.id(3,1) from public.roles where key = 'branch_manager'
  union all select audit_ledger.id(6,6), id, 'entity'::scope_type, audit_ledger.id(1,1) from public.roles where key = 'entity_admin'
  union all select audit_ledger.id(6,7), id, 'entity'::scope_type, audit_ledger.id(1,1) from public.roles where key = 'hr_manager'
  union all select audit_ledger.id(6,9), id, 'entity'::scope_type, audit_ledger.id(1,2) from public.roles where key = 'entity_admin'
  union all select audit_ledger.id(6,10), id, 'department'::scope_type, audit_ledger.id(4,1) from public.roles where key = 'dept_head';
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_ledger.id(6,n), id, 'self'::scope_type from public.roles, generate_series(1,2) n where key = 'employee';


-- Dates -------------------------------------------------------------------------------------------
do $$ begin
  assert app.ledger_advance_date('2026-01-31', 'monthly') = '2026-02-28', 'monthly clamps to February';
  assert app.ledger_advance_date('2028-01-31', 'monthly') = '2028-02-29', 'leap year';
  assert app.ledger_advance_date('2026-02-28', 'monthly') = '2026-03-28', 'counts from the previous deadline';
  assert app.ledger_advance_date('2026-10-09', 'weekdays') = '2026-10-12', 'Friday to Monday';
  assert app.ledger_advance_date('2026-10-10', 'weekdays') = '2026-10-12', 'Saturday to Monday';
  assert app.ledger_advance_date('2026-10-07', 'weekdays') = '2026-10-08', 'midweek to next day';
  assert app.ledger_advance_date('2026-10-07', 'daily') = '2026-10-08' and app.ledger_advance_date('2026-10-07', 'weekly') = '2026-10-14', 'daily and weekly';
  assert (select from_date = '2026-10-05' and to_date = '2026-10-11' and not single_day from app.ledger_period('week', '2026-10-11', '2026-10-20')), 'Sunday belongs to the week starting Monday';
  assert (select from_date = '2026-02-01' and to_date = '2026-02-28' from app.ledger_period('month', '2026-02', '2026-10-20')), 'month range';
  assert (select from_date = '2026-10-20' and single_day from app.ledger_period('day', null, '2026-10-20')), 'today by default';
  assert (select from_date = '2000-01-01' and to_date = '2026-10-20' from app.ledger_period('all', null, '2026-10-20')), 'overall';
  assert (select from_date = '2026-10-01' and to_date = '2026-10-15' from app.ledger_period('range', '2026-10-01|2026-10-15', '2026-10-20')), 'custom';
  assert app.ledger_ist_timestamp('2026-10-07T23:30') = '2026-10-07 18:00:00+00', 'wall-clock time in Asia/Kolkata';
end $$;
select audit_ledger.expect_error($q$select * from app.ledger_period('range','2026-10-15|2026-10-01','2026-10-20')$q$, '22023');
select audit_ledger.expect_error($q$select * from app.ledger_period('month','October','2026-10-20')$q$, '22023');
select audit_ledger.expect_error($q$select * from app.ledger_period('day','2026-02-30','2026-10-20')$q$, '22023');
select audit_ledger.expect_error($q$select * from app.ledger_period('year',null,'2026-10-20')$q$, '22023');
select 'PASS: monthly repeats clamp to month end, weekdays skip weekends, periods run Monday to Sunday in Asia/Kolkata' as result;

-- Reminders and Google Calendar -----------------------------------------------------------------
create temp table ids(label text primary key, id uuid not null default gen_random_uuid());
grant all on ids to authenticated, anon;
insert into ids(label) select unnest(array['remind1','remind2','remind3']);
create function audit_ledger.idof(_label text) returns uuid language sql as $$ select id from ids where label = _label $$;
grant execute on function audit_ledger.idof(text) to authenticated, anon;
set role authenticated;
select audit_ledger.as_user(1);
do $$ declare _r jsonb; _begin jsonb; _out jsonb;
begin
  _r := public.ledger_add_reminder(audit_ledger.idof('remind1'), '{"text":"Call printer","due_at":"2026-10-24T10:00","repeat":"weekdays"}');
  assert _r->'reminder'->>'due_at' = '2026-10-26T10:00', 'a weekday reminder on Saturday moves to Monday';
  assert not (_r->>'calendar')::boolean and _r->'reminder'->>'calendar_state' = 'none', 'saved in the app without a calendar';
  _r := public.ledger_complete_reminder(audit_ledger.idof('remind1'));
  assert _r->>'due_at' = '2026-10-27T10:00' and not (_r->>'done')::boolean, 'repeating reminder moves to its next day';
  perform public.ledger_add_reminder(audit_ledger.idof('remind2'), '{"text":"Send proofs","due_at":"2026-10-08T16:30"}');
  _r := public.ledger_snooze_reminder(audit_ledger.idof('remind2'), '2026-10-09T09:00');
  assert _r->>'due_at' = '2026-10-09T09:00', 'snoozed';
  _r := public.ledger_complete_reminder(audit_ledger.idof('remind2'));
  assert (_r->>'done')::boolean, 'one-off finished';
  _r := public.ledger_add_reminder(audit_ledger.idof('remind3'), '{"text":"Follow up: chase landlord","due_at":"2026-10-30T11:00","source":"followup"}');
  assert _r->'reminder'->>'source' = 'followup', 'a follow-up';

  _begin := public.ledger_google_begin();
  assert length(_begin->>'nonce') = 64 and (_begin->>'owner')::uuid = audit_ledger.id(6,1), 'nonce for the OAuth state';
  insert into ids(label, id) values ('nonce-owner', (_begin->>'owner')::uuid);
  create temp table nonce(value text);
  insert into nonce values (_begin->>'nonce');
end $$;
grant select on nonce to anon, authenticated;
select audit_ledger.expect_error(format('select public.ledger_snooze_reminder(%L, %L)', audit_ledger.idof('remind1'), '2026-10-28T10:00'), '22023');
reset role;
set role anon;
set request.jwt.claim.sub = '';
select audit_ledger.expect_error(format('select public.ledger_google_complete(%L, %L, %L, %L)', repeat('0', 64), audit_ledger.id(6,1), 'me@example.test', 'v1:abc'), '42501');
select audit_ledger.expect_error(format('select public.ledger_google_complete(%L, %L, %L, %L)', (select value from nonce), audit_ledger.id(6,2), 'me@example.test', 'v1:abc'), '42501');
do $$ begin
  assert public.ledger_google_complete((select value from nonce), audit_ledger.id(6,1), 'vivek@parakkat.example', 'v1:c2VjcmV0LWNpcGhlcnRleHQ', 'workspace'), 'connected';
end $$;
select audit_ledger.expect_error(format('select public.ledger_google_complete(%L, %L, %L, %L)', (select value from nonce), audit_ledger.id(6,1), 'me@example.test', 'v1:abc'), '42501');
select audit_ledger.expect_error('select * from app.ledger_google', '42501');
reset role;
set role authenticated;
select audit_ledger.as_user(1);
do $$ declare _out jsonb; _status jsonb;
begin
  _status := public.ledger_google_status();
  assert (_status->>'connected')::boolean and _status->>'email' = 'vivek@parakkat.example', 'status shows the account';
  assert public.ledger_google_secret()->>'ciphertext' = 'v1:c2VjcmV0LWNpcGhlcnRleHQ', 'the server can fetch the sealed token';
  _out := public.ledger_calendar_outbox();
  assert _out @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'insert', 'repeat', 'weekdays')), 'open reminders queued for the calendar';
  assert not (_out @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind2')))), 'finished reminders are not sent';
  perform public.ledger_calendar_ack(jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'insert', 'ok', true, 'event_id', 'ldrabc'),
    jsonb_build_object('id', audit_ledger.idof('remind3'), 'op', 'insert', 'ok', false, 'error', 'quota')));
  assert (select calendar_state = 'synced' and calendar_event_id = 'ldrabc' from public.ledger_reminders where id = audit_ledger.idof('remind1')), 'synced';
  assert (select calendar_state = 'failed' and calendar_error = 'quota' from public.ledger_reminders where id = audit_ledger.idof('remind3')), 'failure recorded';
  perform public.ledger_delete_reminder(audit_ledger.idof('remind1'));
  assert public.ledger_calendar_outbox() @> jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'delete', 'event_id', 'ldrabc')), 'deleting removes the event';
  perform public.ledger_calendar_ack(jsonb_build_array(jsonb_build_object('id', audit_ledger.idof('remind1'), 'op', 'delete', 'ok', true)));
  assert (select calendar_state = 'none' and calendar_event_id is null and deleted_at is not null from public.ledger_reminders where id = audit_ledger.idof('remind1')), 'event gone, reminder kept';
  perform public.ledger_google_mark('needs_reconnect');
  assert public.ledger_google_status()->>'status' = 'needs_reconnect', 'expired grants ask to reconnect';
  perform public.ledger_google_disconnect();
  assert not (public.ledger_google_status()->>'connected')::boolean and public.ledger_google_secret() is null, 'disconnect forgets the token';
end $$;
select audit_ledger.as_user(3);
do $$ begin
  assert public.ledger_google_secret() is null, 'nobody else can fetch it';
  assert (select count(*) from public.ledger_reminders where owner_user = audit_ledger.id(6,1)) = 0, 'manager sees no reminders';
end $$;
select 'PASS: reminders move off weekends, repeat, snooze and follow up; Google connects only with a fresh single-use nonce; the outbox syncs inserts, failures and deletes' as result;
reset role;

-- The retired personal ledger (removed by 0177) -----------------------------------------------------
do $$ begin
  assert to_regclass('public.ledger_tasks') is null and to_regclass('public.ledger_campaigns') is null
    and to_regclass('public.ledger_settings') is null, 'the personal-ledger tables are gone';
  assert to_regprocedure('public.ledger_open()') is null and to_regprocedure('public.ledger_home(uuid)') is null, 'and their functions';
  assert not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ledger_reminders' and column_name = 'task_id'),
    'reminders link only to real tasks';
  assert to_regclass('public.ledger_reminders') is not null and to_regclass('app.ledger_google') is not null
    and to_regclass('app.ledger_seed_key_dates') is not null, 'reminders, Google Calendar and the festival calendar stay';
end $$;
select 'PASS: the retired personal ledger is gone; reminders, Google Calendar and the festival calendar stay' as result;
