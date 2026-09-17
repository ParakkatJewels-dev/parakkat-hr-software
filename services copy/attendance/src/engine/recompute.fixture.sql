-- Minimal, disposable PostgreSQL contract for the real recompute loaders and writer.
create schema app;
create schema auth;
create role anon;
create role authenticated;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create function app.is_super_admin() returns boolean language sql as $$ select true $$;
create function app.has_perm(text, uuid, uuid, uuid, uuid, uuid) returns boolean language sql as $$ select true $$;
create table employees (id uuid primary key, entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid, join_date date, status text default 'Active');
create table shifts (
 id uuid primary key, entity_id uuid, code text, name text,
 start_time time, end_time time, crosses_midnight boolean,
 grace_in_minutes int default 0, grace_out_minutes int default 0,
 break_minutes int default 0, break_policy text default 'actual', weekly_offs int[] default '{}',
 full_day_minutes int default 480, half_day_minutes int default 240,
 ot_after_minutes int default 0, min_ot_minutes int default 1, ot_basis text default 'worked',
 missed_punch_policy text default 'exception', late_absent_minutes int default 1440,
 early_absent_minutes int default 1440, is_flexible boolean default false,
 short_day_tolerance_minutes int default 30, is_default boolean default false, is_active boolean default true
);
create table employee_shift_assignments (employee_id uuid, shift_id uuid, effective_from date, effective_to date);
create function calendar_for_employee(uuid) returns uuid language sql as $$ select null::uuid $$;
create table holidays (calendar_id uuid, holiday_date date, name text, is_optional boolean);
create table leave_types (code text primary key, is_paid boolean);
create table leaves (id uuid primary key, employee_id uuid, start_date date, end_date date, type text, status text, is_lop boolean, day_fraction numeric, cancelled_dates date[]);
create table attendance_regularizations (id uuid, employee_id uuid, work_date date, check_in timestamptz, check_out timestamptz, status text);
create table raw_punches (id bigint generated always as identity, employee_id uuid, punch_time timestamptz, punch_state text, terminal_sn text, terminal_alias text);
create table attendance (
 employee_id uuid, work_date date, shift_id uuid, status text, day_type text,
 check_in timestamptz, check_out timestamptz, first_punch_at timestamptz, last_punch_at timestamptz,
 punch_count int, scheduled_in timestamptz, scheduled_out timestamptz, hours numeric,
 worked_minutes int, late_minutes int, early_exit_minutes int, ot_minutes int,
 is_late boolean, is_early_exit boolean, is_missing_punch boolean,
 leave_id uuid, leave_type text, is_lop boolean, day_fraction numeric,
 regularization_id uuid, source text, remarks text, computed_at timestamptz,
 punches jsonb, break_minutes int, breaks_incomplete boolean, is_short_day boolean, is_long_break boolean,
 is_locked boolean not null default false, status_override text, status_override_note text,
 primary key(employee_id, work_date)
);
create table attendance_recompute_queue (
 id bigint generated always as identity primary key, employee_id uuid, work_date date not null,
 reason text not null, requested_at timestamptz not null default now(), processed_at timestamptz
);
create unique index idx_recompute_unique_pending on attendance_recompute_queue(employee_id, work_date) where processed_at is null;
create function enqueue_recompute(_employee_id uuid, _from date, _to date default null, _reason text default 'manual') returns integer language plpgsql as $$
declare _n integer;
begin
 insert into attendance_recompute_queue(employee_id, work_date, reason)
 select _employee_id, d::date, _reason from generate_series(_from, coalesce(_to, _from), interval '1 day') d
 on conflict do nothing;
 get diagnostics _n = row_count;
 return _n;
end $$;
create function app.enqueue_recompute_internal(uuid, date, date, text default 'system') returns integer language sql as $$ select public.enqueue_recompute($1, $2, $3, $4) $$;
-- Enqueue a correction precisely after engine loaders finish but before the queue is acknowledged.
create table race_control (enabled boolean);
insert into race_control values(false);
create function app.fixture_enqueue_during_write() returns trigger language plpgsql as $$
begin
 if (select enabled from race_control) then
   update race_control set enabled = false;
   perform app.enqueue_recompute_internal(new.employee_id, new.work_date, new.work_date, 'Correction after data load');
 end if;
 return new;
end $$;
create trigger fixture_during_write before insert on attendance for each row execute function app.fixture_enqueue_during_write();
