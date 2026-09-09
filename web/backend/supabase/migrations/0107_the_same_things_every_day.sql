-- 0107_the_same_things_every_day.sql
--
-- Most of a shift is not projects. It is the same handful of duties, every day: check the mould
-- temperature, log the scrap weight, sign the shift sheet. Those are not tasks — a task is a thing
-- you finish — and filing them as tasks would have been 163 staff x 5 duties = 815 new rows every
-- morning, 300,000 a year, burying the board they share and firing 815 notifications with it.
--
-- So: a routine is DEFINED once and TICKED daily. One row per duty, one row per tick. A head writes
-- the routine for their team; the person doing it ticks their own; the head sees today at a glance.
--
-- NO NEW PERMISSION, ON PURPOSE. Reading follows task.read — an employee holds it at self scope and
-- sees their own list, a head holds it over their team and sees theirs. Defining follows
-- task.create, which 0021 deliberately took away from employees precisely so that work is assigned
-- downward and not upward. The people who should be able to do each of these things already can,
-- with no grant to remember and no screen that appears for nobody.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- the duty
-- ---------------------------------------------------------------------------
create table if not exists public.routine_items (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id   uuid, zone_id uuid, branch_id uuid, department_id uuid,   -- stamped by trigger
  title       text not null,
  detail      text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_by  uuid references public.employees(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint routine_items_title_not_empty check (btrim(title) <> '')
);

create index if not exists idx_routine_items_employee on public.routine_items(employee_id) where is_active;

-- Same ancestry stamper every module table uses, so scope questions have one answer.
drop trigger if exists trg_routine_items_ancestry on public.routine_items;
create trigger trg_routine_items_ancestry
  before insert or update of employee_id on public.routine_items
  for each row execute function app.tg_stamp_ancestry();

alter table public.routine_items enable row level security;

drop policy if exists routine_items_select on public.routine_items;
create policy routine_items_select on public.routine_items for select to authenticated
  using (app.has_perm('task.read', entity_id, zone_id, branch_id, department_id, employee_id));

drop policy if exists routine_items_write on public.routine_items;
create policy routine_items_write on public.routine_items for all to authenticated
  using (app.has_perm('task.create', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('task.create', entity_id, zone_id, branch_id, department_id, employee_id));

grant select, insert, update, delete on public.routine_items to authenticated;

-- ---------------------------------------------------------------------------
-- the tick
--
-- `on_date` is the working day in IST, passed in by the client rather than defaulted to
-- current_date: the server is UTC, so between 00:00 and 05:30 IST a default would file the morning
-- shift's ticks against yesterday. Same reason dates.js exists.
--
-- The unique index is the whole integrity story — one tick per duty per day. Ticking twice is not
-- an error to show somebody, it is the same fact arriving twice, so the client upserts.
-- ---------------------------------------------------------------------------
create table if not exists public.routine_ticks (
  id              uuid primary key default gen_random_uuid(),
  routine_item_id uuid not null references public.routine_items(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  entity_id       uuid, zone_id uuid, branch_id uuid, department_id uuid,
  on_date         date not null,
  done_at         timestamptz not null default now(),
  done_by         uuid references public.employees(id) on delete set null,
  unique (routine_item_id, on_date)
);

create index if not exists idx_routine_ticks_day on public.routine_ticks(on_date, employee_id);

drop trigger if exists trg_routine_ticks_ancestry on public.routine_ticks;
create trigger trg_routine_ticks_ancestry
  before insert or update of employee_id on public.routine_ticks
  for each row execute function app.tg_stamp_ancestry();

alter table public.routine_ticks enable row level security;

drop policy if exists routine_ticks_select on public.routine_ticks;
create policy routine_ticks_select on public.routine_ticks for select to authenticated
  using (app.has_perm('task.read', entity_id, zone_id, branch_id, department_id, employee_id));

-- task.update, not task.create: ticking is progress, and progress is the one thing an employee may
-- record on their own work (0017). A head holds it over their team and can tick for somebody who
-- is off the floor.
drop policy if exists routine_ticks_write on public.routine_ticks;
create policy routine_ticks_write on public.routine_ticks for all to authenticated
  using (app.has_perm('task.update', entity_id, zone_id, branch_id, department_id, employee_id))
  with check (app.has_perm('task.update', entity_id, zone_id, branch_id, department_id, employee_id));

grant select, insert, update, delete on public.routine_ticks to authenticated;

-- ---------------------------------------------------------------------------
-- realtime: a head watching today's board should see it fill in
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='routine_ticks') then
    alter publication supabase_realtime add table public.routine_ticks;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname='supabase_realtime' and schemaname='public' and tablename='routine_items') then
    alter publication supabase_realtime add table public.routine_items;
  end if;
  alter table public.routine_ticks replica identity full;
  alter table public.routine_items replica identity full;
end $$;

commit;
