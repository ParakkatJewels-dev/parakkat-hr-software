-- 0015_repair_attendance_fks.sql
--
-- Fixes: "Could not find a relationship between 'attendance' and 'shifts' in the schema cache"
--
-- PostgREST builds its embed graph from foreign keys. `attendance` gained `shift_id` in 0013 via
--   alter table public.attendance add column if not exists shift_id uuid references public.shifts(id)
-- and `IF NOT EXISTS` is the trap: if the column already existed from an earlier partial run, the
-- whole clause is skipped — including the REFERENCES — so the column is there but the foreign key
-- never gets created, and the embed stays invisible.
--
-- This migration is idempotent and safe to run whether 0013 applied cleanly, partially, or not at
-- all. It adds only what is genuinely missing, then asks PostgREST to reload its cache.
--
-- If it reports that public.shifts does not exist, 0013 never ran: apply that first.

do $$
begin
  if to_regclass('public.shifts') is null then
    raise exception
      'public.shifts does not exist — migration 0013_attendance_engine.sql has not been applied. Apply it first, then re-run this file.';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- attendance.shift_id -> shifts.id
-- --------------------------------------------------------------------------
alter table public.attendance add column if not exists shift_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.attendance'::regclass
       and confrelid = 'public.shifts'::regclass
       and contype = 'f'
  ) then
    -- Clear any orphans first, or the constraint cannot be validated.
    update public.attendance a
       set shift_id = null
     where a.shift_id is not null
       and not exists (select 1 from public.shifts s where s.id = a.shift_id);

    alter table public.attendance
      add constraint attendance_shift_id_fkey
      foreign key (shift_id) references public.shifts(id) on delete set null;

    raise notice 'added attendance.shift_id -> shifts.id';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- attendance.leave_id -> leaves.id   (same IF NOT EXISTS trap in 0013)
-- --------------------------------------------------------------------------
alter table public.attendance add column if not exists leave_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.attendance'::regclass
       and confrelid = 'public.leaves'::regclass
       and contype = 'f'
  ) then
    update public.attendance a
       set leave_id = null
     where a.leave_id is not null
       and not exists (select 1 from public.leaves l where l.id = a.leave_id);

    alter table public.attendance
      add constraint attendance_leave_id_fkey
      foreign key (leave_id) references public.leaves(id) on delete set null;

    raise notice 'added attendance.leave_id -> leaves.id';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- attendance.regularization_id -> attendance_regularizations.id
-- (0014 adds this, but only if that migration ran)
-- --------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.attendance_regularizations') is not null then
    alter table public.attendance add column if not exists regularization_id uuid;

    if not exists (
      select 1 from pg_constraint
       where conrelid = 'public.attendance'::regclass
         and confrelid = 'public.attendance_regularizations'::regclass
         and contype = 'f'
    ) then
      update public.attendance a
         set regularization_id = null
       where a.regularization_id is not null
         and not exists (
           select 1 from public.attendance_regularizations r where r.id = a.regularization_id
         );

      alter table public.attendance
        add constraint attendance_regularization_id_fkey
        foreign key (regularization_id) references public.attendance_regularizations(id) on delete set null;

      raise notice 'added attendance.regularization_id -> attendance_regularizations.id';
    end if;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- Report what PostgREST will now see
-- --------------------------------------------------------------------------
do $$
declare
  _fks text;
begin
  select string_agg(cl.relname, ', ' order by cl.relname) into _fks
    from pg_constraint con
    join pg_class cl on cl.oid = con.confrelid
   where con.conrelid = 'public.attendance'::regclass and con.contype = 'f';

  raise notice 'attendance now has foreign keys to: %', coalesce(_fks, '(none)');
end $$;

-- --------------------------------------------------------------------------
-- Reload the PostgREST schema cache.
-- Supabase normally does this automatically on DDL, but the reload can lag — and a correct
-- foreign key that PostgREST has not noticed yet produces exactly the same error as a missing one.
-- --------------------------------------------------------------------------
notify pgrst, 'reload schema';
