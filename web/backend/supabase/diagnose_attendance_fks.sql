-- Diagnose: "Could not find a relationship between 'attendance' and 'shifts' in the schema cache"
-- Paste into the Supabase SQL editor and read the three result sets.

-- 1. Did migration 0013 actually land? Every one of these should say EXISTS.
select 'shifts table'              as thing,
       to_regclass('public.shifts')::text is not null            as exists
union all
select 'attendance.shift_id column',
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='attendance' and column_name='shift_id')
union all
select 'attendance -> shifts FK',
       exists (select 1 from pg_constraint
                where conrelid = 'public.attendance'::regclass
                  and confrelid = 'public.shifts'::regclass
                  and contype = 'f')
union all
select 'employee_shift_assignments', to_regclass('public.employee_shift_assignments')::text is not null
union all
select 'holidays table',            to_regclass('public.holidays')::text is not null
union all
select 'leave_types table',         to_regclass('public.leave_types')::text is not null
union all
select 'attendance_regularizations', to_regclass('public.attendance_regularizations')::text is not null;

-- 2. Which migrations does the tracker think are applied?
select filename, applied_at from _migrations.applied order by filename;

-- 3. Every FK PostgREST can see on attendance (this is what powers embeds).
select con.conname                          as constraint_name,
       att.attname                          as column_name,
       cl.relname                           as references_table
  from pg_constraint con
  join pg_attribute  att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
  join pg_class      cl  on cl.oid = con.confrelid
 where con.conrelid = 'public.attendance'::regclass
   and con.contype = 'f'
 order by 1;
