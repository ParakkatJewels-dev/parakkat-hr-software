-- 0173 The Work Ledger runs on Task Management's own records.
--
-- The team asked for one place for work, and the Work Ledger becomes it. Rather than move every
-- task into the personal-ledger tables, the Ledger now reads and writes public.tasks and its
-- children, so every existing task, subtask, comment, file, request and routine carries straight
-- over. This migration adds the ledger's workflow to those records:
--   review steps (a separate field: the five statuses every other screen, count, notification and
--   Hermes tool relies on keep their meaning), progress notes, deliverables, a history of changes,
--   personal focus and pin, the help log, and the reads behind Home, Reports, Insights and search.
-- Existing rules stay as they are: task RLS, the assignment and trash guards, notifications,
-- section counts and the hr_agent tools. Reminders now point at real tasks.
begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Task columns
-- ---------------------------------------------------------------------------------------------
alter table public.tasks
  add column if not exists review_stage text,
  add column if not exists revision integer not null default 0,
  add column if not exists approved_version text,
  add column if not exists waiting_on text,
  add column if not exists outcome text,
  add column if not exists status_since date,
  add column if not exists depends_on_task_id uuid references public.tasks(id) on delete set null,
  add column if not exists tags text[] not null default '{}',
  add column if not exists brand text,
  add column if not exists work_type text,
  add column if not exists est_cost numeric(12,2),
  add column if not exists actual_cost numeric(12,2);

alter table public.tasks drop constraint if exists tasks_review_stage_check;
alter table public.tasks add constraint tasks_review_stage_check
  check (review_stage is null or review_stage in ('Internal Review','Awaiting Approval','Revisions','Approved'));
alter table public.tasks drop constraint if exists tasks_work_fields_check;
alter table public.tasks add constraint tasks_work_fields_check check (
  revision >= 0 and coalesce(est_cost, 0) >= 0 and coalesce(actual_cost, 0) >= 0
  and char_length(coalesce(waiting_on, '')) <= 200 and char_length(coalesce(outcome, '')) <= 1000
  and char_length(coalesce(approved_version, '')) <= 200 and char_length(coalesce(brand, '')) <= 80
  and char_length(coalesce(work_type, '')) <= 120 and cardinality(tags) <= 20
  and (depends_on_task_id is null or depends_on_task_id <> id));
create index if not exists idx_tasks_depends_on on public.tasks(depends_on_task_id) where depends_on_task_id is not null;

-- Existing work starts its "in this step since" clock at its last known change.
update public.tasks set status_since = app.ledger_ist_date(coalesce(completed_at, created_at)) where status_since is null;

-- ---------------------------------------------------------------------------------------------
-- 2. Steps: status + review stage, named the way people read them
-- ---------------------------------------------------------------------------------------------
create or replace function app.work_lane(_status text, _review text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case
    when _status = 'To Do' then 'todo'
    when _status = 'Blocked' then 'blocked'
    when _status = 'In Progress' and _review = 'Approved' then 'approved'
    when _status = 'In Progress' and _review in ('Internal Review','Awaiting Approval','Revisions') then 'review'
    when _status = 'In Progress' then 'progress'
    else 'closed' end;
$$;

create or replace function app.work_step(_status text, _review text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case
    when _status = 'In Progress' and _review = 'Internal Review' then 'In review'
    when _status = 'In Progress' and _review = 'Awaiting Approval' then 'Waiting for approval'
    when _status = 'In Progress' and _review = 'Revisions' then 'Changes needed'
    when _status = 'In Progress' and _review = 'Approved' then 'Approved'
    when _status = 'To Do' then 'To do'
    when _status = 'In Progress' then 'In progress'
    else _status end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------------------------
-- What happened to a task, written only by triggers.
create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  at timestamptz not null default clock_timestamp(),
  actor_user uuid,
  actor_employee uuid references public.employees(id) on delete set null,
  kind text not null check (kind in ('created','step','assignee','due')),
  from_value text,
  to_value text
);
create index if not exists idx_task_events_task on public.task_events(task_id, at);
create index if not exists idx_task_events_actor on public.task_events(actor_employee, at);

-- "What I did on this today."
create table if not exists public.task_progress (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_user uuid not null default auth.uid(),
  employee_id uuid references public.employees(id) on delete set null,
  on_date date not null default app.ledger_today(),
  note text not null,
  minutes integer,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint task_progress_note check (char_length(btrim(note)) between 1 and 4000),
  constraint task_progress_minutes check (minutes is null or minutes between 1 and 1440)
);
create index if not exists idx_task_progress_task on public.task_progress(task_id, on_date) where deleted_at is null;
create index if not exists idx_task_progress_employee on public.task_progress(employee_id, on_date) where deleted_at is null;

-- Versions of the work itself: "IG story v2, used on the Diwali post".
create table if not exists public.task_deliverables (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  type text,
  version text,
  link text,
  used_where text,
  added_by uuid not null default auth.uid(),
  added_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  constraint task_deliverables_fields check (
    coalesce(nullif(btrim(type), ''), nullif(btrim(link), '')) is not null
    and char_length(coalesce(type, '')) <= 120 and char_length(coalesce(version, '')) <= 80
    and char_length(coalesce(link, '')) <= 2000 and char_length(coalesce(used_where, '')) <= 200
    and (link is null or link ~* '^https?://'))
);
create index if not exists idx_task_deliverables_task on public.task_deliverables(task_id) where deleted_at is null;

-- Each person's own pin and today's focus; two people on one task each choose for themselves.
create table if not exists public.task_marks (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  pinned boolean not null default false,
  focus_date date,
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index if not exists idx_task_marks_focus on public.task_marks(user_id, focus_date) where focus_date is not null;

-- Help and reviews given to colleagues: counted in reports, never a task on anybody's board.
create table if not exists public.task_help_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  entity_id uuid, zone_id uuid, branch_id uuid, department_id uuid,
  on_date date not null default app.ledger_today(),
  what text not null,
  for_whom text,
  minutes integer,
  kind text not null default 'Review / Feedback',
  brand text,
  note text,
  task_id uuid references public.tasks(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint task_help_log_fields check (
    char_length(btrim(what)) between 1 and 500 and char_length(coalesce(for_whom, '')) <= 120
    and (minutes is null or minutes between 1 and 1440) and kind in ('Review / Feedback','Team support')
    and char_length(coalesce(brand, '')) <= 80 and char_length(coalesce(note, '')) <= 2000)
);
create index if not exists idx_task_help_log_employee on public.task_help_log(employee_id, on_date) where deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- 4. Rules (triggers, so the Ledger, Hermes and any older screen behave the same)
-- ---------------------------------------------------------------------------------------------
create or replace function app.tg_task_workflow()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _today date := app.ledger_today(); _version text;
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'In Progress' then new.review_stage := null; end if;
    new.revision := 0;
    new.approved_version := null;
    new.status_since := _today;
    if new.status is distinct from 'Blocked' and new.review_stage is distinct from 'Awaiting Approval' then new.waiting_on := null; end if;
    return new;
  end if;
  -- These follow from the steps below and are never written directly.
  new.revision := old.revision;
  new.approved_version := old.approved_version;
  new.status_since := old.status_since;
  if new.status is distinct from 'In Progress' then new.review_stage := null; end if;
  if row(new.status, new.review_stage) is distinct from row(old.status, old.review_stage) then
    new.status_since := _today;
    if new.review_stage = 'Revisions' and old.review_stage is distinct from 'Revisions' then
      new.revision := old.revision + 1;
    end if;
    if new.review_stage = 'Approved' and old.review_stage is distinct from 'Approved' then
      select coalesce(nullif(btrim(d.version), ''), nullif(btrim(d.type), '')) into _version from public.task_deliverables d
        where d.task_id = new.id and d.deleted_at is null order by d.added_at desc, d.id desc limit 1;
      new.approved_version := coalesce(_version, 'Work as reviewed');
    end if;
    -- Waiting on someone only means something while blocked or waiting for approval.
    if new.status is distinct from 'Blocked' and new.review_stage is distinct from 'Awaiting Approval'
       and new.waiting_on is not distinct from old.waiting_on then
      new.waiting_on := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tasks_workflow on public.tasks;
create trigger trg_tasks_workflow before insert or update on public.tasks
  for each row execute function app.tg_task_workflow();

create or replace function app.tg_task_events()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _me uuid := app.current_employee_id(); _user uuid := auth.uid(); _target uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.task_events(task_id, actor_user, actor_employee, kind, to_value)
      values (new.id, _user, _me, 'created', app.work_step(new.status, new.review_stage));
    return new;
  end if;
  if row(new.status, new.review_stage) is distinct from row(old.status, old.review_stage) then
    insert into public.task_events(task_id, actor_user, actor_employee, kind, from_value, to_value)
      values (new.id, _user, _me, 'step', app.work_step(old.status, old.review_stage), app.work_step(new.status, new.review_stage));
  end if;
  if new.employee_id is distinct from old.employee_id then
    insert into public.task_events(task_id, actor_user, actor_employee, kind, from_value, to_value)
      values (new.id, _user, _me, 'assignee', (select e.full_name from public.employees e where e.id = old.employee_id),
        (select e.full_name from public.employees e where e.id = new.employee_id));
  end if;
  if new.due_date is distinct from old.due_date then
    insert into public.task_events(task_id, actor_user, actor_employee, kind, from_value, to_value)
      values (new.id, _user, _me, 'due', old.due_date::text, new.due_date::text);
  end if;
  -- Review steps tell the other side; plain status changes are already notified (0023).
  if new.review_stage is distinct from old.review_stage and new.review_stage is not null then
    if new.review_stage = 'Awaiting Approval' then
      select e.user_id into _target from public.employees e where e.id = new.assigned_by;
      perform app.notify_user(_target, 'task', 'Waiting for your approval', '"' || new.title || '" is ready for your approval.', 'tasks', new.id);
    elsif new.review_stage = 'Revisions' then
      select e.user_id into _target from public.employees e where e.id = new.employee_id;
      perform app.notify_user(_target, 'task', 'Changes requested', '"' || new.title || '" needs changes (round ' || new.revision || ').', 'tasks', new.id);
    elsif new.review_stage = 'Approved' then
      select e.user_id into _target from public.employees e where e.id = new.employee_id;
      perform app.notify_user(_target, 'task', 'Approved', '"' || new.title || '" was approved.', 'tasks', new.id);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tasks_events on public.tasks;
create trigger trg_tasks_events after insert or update of status, review_stage, employee_id, due_date on public.tasks
  for each row execute function app.tg_task_events();

-- Ticking the last subtask still finishes a task, except one that is in review and not yet approved.
create or replace function app.tg_task_checklist_rollup()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _task uuid; _total int; _done int; _status text; _review text;
begin
  _task := coalesce(new.task_id, old.task_id);

  select count(*), count(completed_at) into _total, _done
    from public.task_checklist_items where task_id = _task;

  select status, review_stage into _status, _review from public.tasks where id = _task;

  if _total = 0 or _status is null or _status = 'Cancelled' then
    return coalesce(new, old);
  end if;

  if _done = _total and _status is distinct from 'Done' then
    if _review is null or _review = 'Approved' then
      update public.tasks set status = 'Done', completed_at = now() where id = _task;
    end if;
  elsif _done < _total and _status = 'Done' then
    -- Back to In Progress rather than To Do: some of it demonstrably happened.
    update public.tasks set status = 'In Progress', completed_at = null where id = _task;
  end if;

  return coalesce(new, old);
end $$;

create or replace function app.tg_task_progress()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'INSERT' then
    new.author_user := auth.uid();
    new.employee_id := app.current_employee_id();
    new.on_date := coalesce(new.on_date, app.ledger_today());
    new.created_at := clock_timestamp();
  else
    new.task_id := old.task_id; new.author_user := old.author_user; new.employee_id := old.employee_id; new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  if new.on_date > app.ledger_today() then
    raise exception using errcode = '22023', message = 'A progress note cannot be dated in the future.';
  end if;
  return new;
end $$;
drop trigger if exists trg_task_progress_stamp on public.task_progress;
create trigger trg_task_progress_stamp before insert or update on public.task_progress
  for each row execute function app.tg_task_progress();

-- The first note on a task that is still To Do means work has started.
create or replace function app.tg_task_progress_start()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  update public.tasks set status = 'In Progress', completed_at = null
    where id = new.task_id and status = 'To Do' and deleted_at is null;
  return new;
end $$;
drop trigger if exists trg_task_progress_start on public.task_progress;
create trigger trg_task_progress_start after insert on public.task_progress
  for each row execute function app.tg_task_progress_start();

create or replace function app.tg_task_deliverable()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'INSERT' then
    new.added_by := auth.uid(); new.added_at := clock_timestamp();
  else
    new.task_id := old.task_id; new.added_by := old.added_by; new.added_at := old.added_at;
  end if;
  new.type := nullif(btrim(new.type), ''); new.version := nullif(btrim(new.version), '');
  new.link := nullif(btrim(new.link), ''); new.used_where := nullif(btrim(new.used_where), '');
  return new;
end $$;
drop trigger if exists trg_task_deliverables_stamp on public.task_deliverables;
create trigger trg_task_deliverables_stamp before insert or update on public.task_deliverables
  for each row execute function app.tg_task_deliverable();

create or replace function app.tg_task_marks()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _today date := app.ledger_today();
begin
  if tg_op = 'INSERT' then new.user_id := auth.uid(); else new.user_id := old.user_id; new.task_id := old.task_id; end if;
  new.updated_at := now();
  if new.focus_date is not null then
    new.focus_date := _today;
    if (select count(*) from public.task_marks m where m.user_id = new.user_id and m.focus_date = _today and m.task_id <> new.task_id) >= 3 then
      raise exception using errcode = '22023', message = 'Today''s focus already has 3 tasks. Remove one first.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_task_marks_rules on public.task_marks;
create trigger trg_task_marks_rules before insert or update on public.task_marks
  for each row execute function app.tg_task_marks();

create or replace function app.tg_task_help_log()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
    new.employee_id := app.current_employee_id();
    if new.employee_id is null then
      raise exception using errcode = '42501', message = 'Only staff with an employee record can log help.';
    end if;
    select e.entity_id, e.zone_id, e.branch_id, e.department_id into new.entity_id, new.zone_id, new.branch_id, new.department_id
      from public.employees e where e.id = new.employee_id;
    new.on_date := coalesce(new.on_date, app.ledger_today());
    new.created_at := clock_timestamp();
  else
    new.user_id := old.user_id; new.employee_id := old.employee_id; new.created_at := old.created_at;
    new.entity_id := old.entity_id; new.zone_id := old.zone_id; new.branch_id := old.branch_id; new.department_id := old.department_id;
    new.updated_at := now();
  end if;
  if new.on_date > app.ledger_today() then
    raise exception using errcode = '22023', message = 'Help cannot be logged for a future day.';
  end if;
  new.what := btrim(new.what); new.for_whom := nullif(btrim(new.for_whom), ''); new.brand := nullif(btrim(new.brand), '');
  new.note := nullif(btrim(new.note), '');
  if new.task_id is not null and not app.can_read_task(new.task_id) then new.task_id := null; end if;
  return new;
end $$;
drop trigger if exists trg_task_help_log_stamp on public.task_help_log;
create trigger trg_task_help_log_stamp before insert or update on public.task_help_log
  for each row execute function app.tg_task_help_log();

revoke all on function app.tg_task_workflow(), app.tg_task_events(), app.tg_task_progress(), app.tg_task_progress_start(),
  app.tg_task_deliverable(), app.tg_task_marks(), app.tg_task_help_log() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Access: the task's own rules decide who sees and changes its parts
-- ---------------------------------------------------------------------------------------------
do $$
declare _table text;
begin
  foreach _table in array array['task_events','task_progress','task_deliverables','task_marks','task_help_log'] loop
    execute format('alter table public.%I enable row level security', _table);
    execute format('revoke all on public.%I from public, anon, authenticated', _table);
    execute format('drop policy if exists active_account_required on public.%I', _table);
    execute format('create policy active_account_required on public.%I as restrictive for all to authenticated using (app.session_is_active()) with check (app.session_is_active())', _table);
  end loop;
end $$;

drop policy if exists task_events_read on public.task_events;
create policy task_events_read on public.task_events for select to authenticated using (app.can_read_task(task_id));
grant select on public.task_events to authenticated;

drop policy if exists task_progress_read on public.task_progress;
create policy task_progress_read on public.task_progress for select to authenticated using (app.can_read_task(task_id));
drop policy if exists task_progress_add on public.task_progress;
create policy task_progress_add on public.task_progress for insert to authenticated
  with check (author_user = auth.uid() and app.can_write_task(task_id));
drop policy if exists task_progress_change on public.task_progress;
create policy task_progress_change on public.task_progress for update to authenticated
  using (author_user = auth.uid() and app.can_read_task(task_id)) with check (author_user = auth.uid() and app.can_read_task(task_id));
grant select, insert, update on public.task_progress to authenticated;

drop policy if exists task_deliverables_read on public.task_deliverables;
create policy task_deliverables_read on public.task_deliverables for select to authenticated using (app.can_read_task(task_id));
drop policy if exists task_deliverables_add on public.task_deliverables;
create policy task_deliverables_add on public.task_deliverables for insert to authenticated
  with check (added_by = auth.uid() and app.can_write_task(task_id));
drop policy if exists task_deliverables_change on public.task_deliverables;
create policy task_deliverables_change on public.task_deliverables for update to authenticated
  using (app.can_write_task(task_id)) with check (app.can_write_task(task_id));
grant select, insert, update on public.task_deliverables to authenticated;

drop policy if exists task_marks_own on public.task_marks;
create policy task_marks_own on public.task_marks for all to authenticated
  using (user_id = auth.uid() and app.can_read_task(task_id)) with check (user_id = auth.uid() and app.can_read_task(task_id));
grant select, insert, update, delete on public.task_marks to authenticated;

drop policy if exists task_help_log_read on public.task_help_log;
create policy task_help_log_read on public.task_help_log for select to authenticated
  using (user_id = auth.uid() or app.has_perm('task.read', entity_id, zone_id, branch_id, department_id, employee_id));
drop policy if exists task_help_log_add on public.task_help_log;
create policy task_help_log_add on public.task_help_log for insert to authenticated with check (user_id = auth.uid());
drop policy if exists task_help_log_change on public.task_help_log;
create policy task_help_log_change on public.task_help_log for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.task_help_log to authenticated;

do $$
declare _table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach _table in array array['task_progress','task_deliverables','task_marks','task_help_log'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = _table) then
      execute format('alter publication supabase_realtime add table public.%I', _table);
    end if;
    execute format('alter table public.%I replica identity full', _table);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Reminders point at real tasks
-- ---------------------------------------------------------------------------------------------
-- A separate link, so the retired personal ledger keeps its own until its tables are removed.
alter table public.ledger_reminders add column if not exists work_task_id uuid references public.tasks(id) on delete set null;
create index if not exists idx_ledger_reminders_work_task on public.ledger_reminders(work_task_id) where work_task_id is not null;

create or replace function app.ledger_reminder_json(_r public.ledger_reminders)
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('id', _r.id, 'text', _r.text, 'due_at', to_char(_r.due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI'),
    'repeat', _r.repeat, 'done', _r.done, 'source', _r.source, 'task_id', coalesce(_r.work_task_id, _r.task_id),
    'task_title', coalesce((select t.title from public.tasks t where t.id = _r.work_task_id and t.deleted_at is null),
      (select t.title from public.ledger_tasks t where t.id = _r.task_id)),
    'overdue', not _r.done and _r.due_at < now(), 'calendar_state', _r.calendar_state);
$$;
revoke all on function app.ledger_reminder_json(public.ledger_reminders) from public, anon, authenticated, service_role;

create or replace function public.ledger_add_reminder(_id uuid, _r jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_reminders; _repeat text; _due timestamptz; _connected boolean;
begin
  if _id is null or _r is null or jsonb_typeof(_r) <> 'object' then raise exception using errcode = '22023', message = 'Send an id and the reminder.'; end if;
  select * into _row from public.ledger_reminders where id = _id;
  if _row.id is not null then
    if _row.owner_user <> _owner then raise exception using errcode = '42501', message = 'That id is taken.'; end if;
    return jsonb_build_object('reminder', app.ledger_reminder_json(_row), 'calendar', app.ledger_calendar_connected(_owner));
  end if;
  if (_r->>'due_at') is null or (_r->>'due_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then
    raise exception using errcode = '22023', message = 'A reminder needs a time like 2026-10-08T10:00.';
  end if;
  _repeat := app.ledger_pick(_r->>'repeat', array['daily','weekly','weekdays','monthly'], 'Repeat');
  _due := app.ledger_reminder_due(app.ledger_ist_timestamp(_r->>'due_at'), _repeat);
  _connected := app.ledger_calendar_connected(_owner);
  insert into public.ledger_reminders(id, owner_user, text, due_at, repeat, source, task_id, work_task_id, calendar_state)
    values (_id, _owner, coalesce(app.ledger_json_text(_r, 'text', 500), 'Reminder'), _due, _repeat,
      coalesce(app.ledger_pick(_r->>'source', array['reminder','followup'], 'Source'), 'reminder'),
      (select t.id from public.ledger_tasks t where t.id = nullif(_r->>'task_id', '')::uuid and t.owner_user = _owner),
      (select t.id from public.tasks t where t.id = nullif(_r->>'task_id', '')::uuid and t.deleted_at is null and app.can_read_task(t.id)),
      case when _connected then 'pending' else 'none' end)
    returning * into _row;
  return jsonb_build_object('reminder', app.ledger_reminder_json(_row), 'calendar', _connected);
end $$;

-- ---------------------------------------------------------------------------------------------
-- 7. Reads. Invoker functions: the task tables' own policies decide what each person sees.
-- ---------------------------------------------------------------------------------------------
create or replace function app.work_can_see_employee(_employee uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.session_is_active() and _employee is not null and (_employee = app.current_employee_id()
    or exists (select 1 from public.employees e where e.id = _employee
      and app.has_perm('task.read', e.entity_id, e.zone_id, e.branch_id, e.department_id, e.id)));
$$;

create or replace function app.work_card(_t public.tasks, _today date)
returns jsonb language sql stable set search_path = pg_catalog, public, app as $$
  select jsonb_build_object(
    'id', _t.id, 'title', _t.title, 'description', left(_t.description, 280),
    'status', _t.status, 'review_stage', _t.review_stage, 'step', app.work_step(_t.status, _t.review_stage),
    'lane', app.work_lane(_t.status, _t.review_stage), 'priority', _t.priority, 'due_date', _t.due_date,
    'status_since', _t.status_since, 'created_at', _t.created_at, 'completed_at', _t.completed_at,
    'stale', _t.status not in ('Done','Cancelled') and coalesce(_t.status_since, app.ledger_ist_date(_t.created_at)) < _today - 7,
    'overdue', _t.status not in ('Done','Cancelled') and _t.due_date < _today,
    'waiting_on', _t.waiting_on, 'revision', _t.revision, 'approved_version', _t.approved_version, 'outcome', _t.outcome,
    'tags', to_jsonb(_t.tags), 'brand', _t.brand, 'work_type', _t.work_type, 'est_cost', _t.est_cost, 'actual_cost', _t.actual_cost,
    'employee_id', _t.employee_id, 'assignee_name', (select e.full_name from public.employees e where e.id = _t.employee_id),
    'assigned_by', _t.assigned_by, 'assigner_name', (select e.full_name from public.employees e where e.id = _t.assigned_by),
    'helpers', (select count(*) from public.task_assignees a where a.task_id = _t.id and a.employee_id <> _t.employee_id),
    'department_id', _t.department_id,
    'depends_on_task_id', _t.depends_on_task_id,
    'depends_on_title', (select d.title from public.tasks d where d.id = _t.depends_on_task_id),
    'depends_on_done', (select d.status = 'Done' from public.tasks d where d.id = _t.depends_on_task_id),
    'subtasks_total', (select count(*) from public.task_checklist_items c where c.task_id = _t.id),
    'subtasks_done', (select count(c.completed_at) from public.task_checklist_items c where c.task_id = _t.id),
    'deliverables_count', (select count(*) from public.task_deliverables d where d.task_id = _t.id and d.deleted_at is null),
    'attachments_count', (select count(*) from public.task_attachments a where a.task_id = _t.id),
    'comments_count', (select count(*) from public.task_comments c where c.task_id = _t.id),
    'last_progress', (select jsonb_build_object('date', p.on_date, 'note', p.note, 'minutes', p.minutes) from public.task_progress p
      where p.task_id = _t.id and p.deleted_at is null order by p.on_date desc, p.created_at desc limit 1),
    'pinned', coalesce((select m.pinned from public.task_marks m where m.task_id = _t.id and m.user_id = auth.uid()), false),
    'focused', coalesce((select m.focus_date = _today from public.task_marks m where m.task_id = _t.id and m.user_id = auth.uid()), false),
    'can_edit', app.can_write_task(_t.id));
$$;

-- The signed-in person's reminders and calendar state. Never anyone else's.
create or replace function app.work_schedule()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce(jsonb_agg(app.ledger_reminder_json(r) order by r.due_at), '[]') from public.ledger_reminders r
  where r.owner_user = auth.uid() and r.deleted_at is null and not r.done
    and r.due_at < ((app.ledger_today() + 2)::timestamp at time zone 'Asia/Kolkata');
$$;
create or replace function app.work_google()
returns jsonb language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select jsonb_build_object('connected', g.status = 'connected' and g.refresh_ct is not null, 'status', g.status, 'email', g.google_email)
    from app.ledger_google g where g.owner_user = auth.uid()), jsonb_build_object('connected', false, 'status', 'disconnected'));
$$;

-- Home: my open work, today's numbers, my schedule.
create or replace function public.work_home()
returns jsonb language sql stable security invoker set search_path = pg_catalog, public, app as $$
  with ctx as (select app.current_employee_id() as me, app.ledger_today() as today),
  mine as (
    select t as task, t.id, t.status, t.due_date, t.created_at, t.completed_at
    from public.tasks t, ctx
    where t.deleted_at is null and ctx.me is not null
      and (t.employee_id = ctx.me or exists (select 1 from public.task_assignees a where a.task_id = t.id and a.employee_id = ctx.me))
  ),
  marks as (select m.task_id, m.pinned, m.focus_date from public.task_marks m where m.user_id = auth.uid()),
  help as (select h.minutes from public.task_help_log h, ctx where h.employee_id = ctx.me and h.deleted_at is null and h.on_date = ctx.today)
  select jsonb_build_object(
    'today', ctx.today,
    'employee_id', ctx.me,
    'pending', coalesce((select jsonb_agg(app.work_card(m.task, ctx.today)
        order by coalesce(k.pinned, false) desc, coalesce(k.focus_date = ctx.today, false) desc, m.due_date nulls last, m.created_at, m.id)
      from mine m left join marks k on k.task_id = m.id where m.status not in ('Done','Cancelled')), '[]'),
    'completed_today', coalesce((select jsonb_agg(app.work_card(m.task, ctx.today) order by m.completed_at desc)
      from mine m where m.status = 'Done' and app.ledger_ist_date(m.completed_at) = ctx.today), '[]'),
    'done_this_week', (select count(*) from mine m where m.status = 'Done'
      and app.ledger_ist_date(m.completed_at) between ctx.today - (extract(isodow from ctx.today)::integer - 1) and ctx.today),
    'worked_on_today', (select count(distinct p.task_id) from public.task_progress p
      where p.employee_id = ctx.me and p.deleted_at is null and p.on_date = ctx.today),
    'support_today', (select count(*) from help),
    'support_minutes_today', (select coalesce(sum(h.minutes), 0) from help h),
    'overdue', (select count(*) from mine m where m.status not in ('Done','Cancelled') and m.due_date < ctx.today),
    'schedule', app.work_schedule(),
    'google', app.work_google())
  from ctx;
$$;

-- One task with its ledger parts. Subtasks, comments and files keep their own reads.
create or replace function public.work_task(_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, app as $$
declare _t public.tasks; _today date := app.ledger_today();
begin
  select * into _t from public.tasks where id = _id and deleted_at is null;
  if _t.id is null then raise exception using errcode = 'P0002', message = 'Task not found.'; end if;
  return app.work_card(_t, _today) || jsonb_build_object(
    'description', _t.description,
    'progress', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'date', p.on_date, 'note', p.note, 'minutes', p.minutes,
        'author', (select e.full_name from public.employees e where e.id = p.employee_id), 'mine', p.author_user = auth.uid())
        order by p.on_date desc, p.created_at desc)
      from public.task_progress p where p.task_id = _id and p.deleted_at is null), '[]'),
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'type', d.type, 'version', d.version, 'link', d.link,
        'used_where', d.used_where, 'added_at', d.added_at) order by d.added_at, d.id)
      from public.task_deliverables d where d.task_id = _id and d.deleted_at is null), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'from', e.from_value, 'to', e.to_value,
        'by', (select x.full_name from public.employees x where x.id = e.actor_employee)) order by e.at desc, e.id desc)
      from (select * from public.task_events e where e.task_id = _id order by e.at desc, e.id desc limit 50) e), '[]'));
end $$;

-- Reports: the ledger's report shape, built from one person's tasks, notes, steps and help.
create or replace function app.work_report_data(_emp uuid, _period text, _from date, _to date, _today date, _single boolean)
returns jsonb language sql stable set search_path = pg_catalog, public, app as $$
with t as (
  select t.id, t.title, t.status, t.review_stage, t.brand, t.work_type, t.outcome, t.waiting_on, t.due_date, t.est_cost, t.actual_cost,
    t.created_at, app.ledger_ist_date(t.created_at) as logged_on, coalesce(t.status_since, app.ledger_ist_date(t.created_at)) as since,
    app.ledger_ist_date(t.completed_at) as done_on, coalesce(nullif(btrim(t.brand), ''), '') as brand_label
  from public.tasks t
  where t.deleted_at is null
    and (t.employee_id = _emp or exists (select 1 from public.task_assignees a where a.task_id = t.id and a.employee_id = _emp))
),
notes as (
  select p.task_id, p.on_date, p.note, p.minutes, p.created_at, p.id from public.task_progress p
  where p.employee_id = _emp and p.deleted_at is null
),
moves as (
  select e.task_id from public.task_events e
  where e.actor_employee = _emp and e.kind = 'step' and app.ledger_ist_date(e.at) between _from and _to group by e.task_id
),
work as (
  select t.*, (t.id in (select task_id from moves)) as moved, (t.logged_on between _from and _to) as is_new,
    exists (select 1 from notes n where n.task_id = t.id and n.on_date between _from and _to) as noted
  from t where t.status not in ('Done','Cancelled')
),
worked as (
  select w.*, case when w.moved and w.review_stage is not null then 0 when w.moved then 1 else 2 end as grp
  from work w where w.moved or w.is_new or w.noted
),
delivered as (select t.* from t where t.status = 'Done' and t.done_on between _from and _to),
support as (
  select h.* from public.task_help_log h where h.employee_id = _emp and h.deleted_at is null and h.on_date between _from and _to
),
active as (select t.* from t where t.id in (select id from worked) or t.id in (select id from delivered)),
open_tasks as (select t.* from t where t.status not in ('Done','Cancelled'))
select jsonb_build_object(
  'period', _period, 'from', _from, 'to', _to, 'today', _today, 'single_day', _single, 'employee_id', _emp,
  'employee_name', (select e.full_name from public.employees e where e.id = _emp),
  'worked_on', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'title', w.title, 'brand', w.brand, 'brand_label', w.brand_label,
      'status', app.work_step(w.status, w.review_stage),
      'event', case when w.moved then app.ledger_status_event(coalesce(w.review_stage, w.status)) end, 'is_new', w.is_new, 'group', w.grp,
      'notes', coalesce((select jsonb_agg(jsonb_build_object('date', n.on_date, 'note', n.note, 'minutes', n.minutes) order by n.on_date, n.created_at, n.id)
        from notes n where n.task_id = w.id and n.on_date between _from and _to), '[]'))
    order by w.grp, lower(w.brand_label), w.created_at, w.id) from worked w), '[]'),
  'delivered', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'brand', d.brand, 'brand_label', d.brand_label,
      'outcome', d.outcome, 'delivered_on', d.done_on,
      'notes', coalesce((select jsonb_agg(jsonb_build_object('date', n.on_date, 'note', n.note, 'minutes', n.minutes) order by n.on_date, n.created_at, n.id)
        from notes n where n.task_id = d.id), '[]'))
    order by lower(d.brand_label), d.done_on, d.created_at, d.id) from delivered d), '[]'),
  'support', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.what, 'for_whom', s.for_whom, 'minutes', s.minutes,
      'brand', s.brand, 'brand_label', coalesce(s.brand, ''), 'type', s.kind, 'date', s.on_date)
    order by s.on_date, s.created_at, s.id) from support s), '[]'),
  'support_by_person', coalesce((select jsonb_agg(jsonb_build_object('person', x.person, 'count', x.n, 'minutes', x.minutes) order by x.n desc, lower(x.person))
    from (select coalesce(nullif(btrim(s.for_whom), ''), 'Unnamed') as person, count(*) as n, coalesce(sum(s.minutes), 0) as minutes
      from support s group by 1) x), '[]'),
  'support_minutes', (select coalesce(sum(s.minutes), 0) from support s),
  'pending_now', case when _single then coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'brand', o.brand,
      'brand_label', o.brand_label, 'status', app.work_step(o.status, o.review_stage), 'deadline', o.due_date,
      'untouched', not exists (select 1 from worked w where w.id = o.id))
    order by lower(o.brand_label), o.created_at, o.id) from open_tasks o), '[]') else '[]'::jsonb end,
  'overdue', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'brand', o.brand, 'brand_label', o.brand_label,
      'deadline', o.due_date) order by o.due_date, o.created_at, o.id) from open_tasks o where o.due_date < _today), '[]'),
  'blocked', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'brand', o.brand, 'brand_label', o.brand_label,
      'status', app.work_step(o.status, o.review_stage), 'waiting_on', o.waiting_on, 'since', o.since) order by o.since, o.created_at, o.id)
    from open_tasks o where o.status = 'Blocked' or o.review_stage in ('Awaiting Approval','Internal Review')), '[]'),
  'wins', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'brand_label', d.brand_label, 'outcome', d.outcome)
    order by d.done_on, d.created_at, d.id) from delivered d where nullif(btrim(d.outcome), '') is not null), '[]'),
  'by_brand', coalesce((select jsonb_agg(jsonb_build_object('brand', x.brand, 'label', x.brand, 'items', x.items, 'done', x.done)
    order by lower(x.brand)) from (
      select a.brand_label as brand, count(*) as items, count(*) filter (where a.id in (select d.id from delivered d)) as done
      from active a where a.brand_label <> '' group by a.brand_label) x), '[]'),
  'by_campaign', '[]'::jsonb,
  'by_type', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'items', x.items, 'done', x.done) order by x.items desc, lower(x.type))
    from (select btrim(a.work_type) as type, count(*) as items,
      count(*) filter (where a.id in (select d.id from delivered d)) as done from active a
      where nullif(btrim(a.work_type), '') is not null group by 1) x), '[]'),
  'cost', jsonb_build_object('est', (select coalesce(sum(a.est_cost), 0) from active a), 'actual', (select coalesce(sum(a.actual_cost), 0) from active a)),
  'ideas_captured', '[]'::jsonb
);
$$;

create or replace function public.work_report(_period text default 'day', _date text default null, _employee uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, app as $$
declare _emp uuid := coalesce(_employee, app.current_employee_id()); _today date := app.ledger_today(); _p record;
begin
  if _emp is null then raise exception using errcode = '22023', message = 'Reports are for staff with an employee record.'; end if;
  if not app.work_can_see_employee(_emp) then
    raise exception using errcode = '42501', message = 'You can see reports for yourself and the people you manage.';
  end if;
  select * into _p from app.ledger_period(_period, _date, _today);
  return app.work_report_data(_emp, _p.period, _p.from_date, _p.to_date, _today, _p.single_day);
end $$;

-- Insights: the last six months for one person.
create or replace function public.work_insights(_employee uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, app as $$
declare _emp uuid := coalesce(_employee, app.current_employee_id()); _today date := app.ledger_today();
  _start date := (date_trunc('month', app.ledger_today()) - interval '5 months')::date;
begin
  if _emp is null then raise exception using errcode = '22023', message = 'Insights are for staff with an employee record.'; end if;
  if not app.work_can_see_employee(_emp) then
    raise exception using errcode = '42501', message = 'You can see insights for yourself and the people you manage.';
  end if;
  return (with months as (select generate_series(_start, date_trunc('month', _today)::date, interval '1 month')::date as m),
  tasks as (
    select t.*, app.ledger_ist_date(t.created_at) as logged_on, app.ledger_ist_date(t.completed_at) as done_on from public.tasks t
    where t.deleted_at is null
      and (t.employee_id = _emp or exists (select 1 from public.task_assignees a where a.task_id = t.id and a.employee_id = _emp))
  ),
  delivered as (select * from tasks where status = 'Done' and done_on >= _start),
  open_tasks as (select * from tasks where status not in ('Done','Cancelled')),
  help as (select * from public.task_help_log h where h.employee_id = _emp and h.deleted_at is null and h.on_date >= _start)
  select jsonb_build_object('from', _start, 'to', _today, 'employee_id', _emp,
    'months', (select jsonb_agg(jsonb_build_object('month', to_char(m.m, 'YYYY-MM'), 'label', to_char(m.m, 'Mon'),
        'delivered', (select count(*) from delivered d where date_trunc('month', d.done_on) = m.m),
        'with_deadline', (select count(*) from delivered d where date_trunc('month', d.done_on) = m.m and d.due_date is not null),
        'on_time', (select count(*) from delivered d where date_trunc('month', d.done_on) = m.m and d.due_date is not null and d.done_on <= d.due_date),
        'support', (select count(*) from help h where date_trunc('month', h.on_date) = m.m),
        'support_minutes', (select coalesce(sum(h.minutes), 0) from help h where date_trunc('month', h.on_date) = m.m),
        'est', (select coalesce(sum(d.est_cost), 0) from delivered d where date_trunc('month', d.done_on) = m.m),
        'actual', (select coalesce(sum(d.actual_cost), 0) from delivered d where date_trunc('month', d.done_on) = m.m))
      order by m.m) from months m),
    'by_brand', coalesce((select jsonb_agg(jsonb_build_object('brand', x.brand, 'delivered', x.n) order by x.n desc, x.brand)
      from (select btrim(brand) as brand, count(*) as n from delivered where nullif(btrim(brand), '') is not null group by 1) x), '[]'),
    'turnaround_by_type', coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'days', x.days, 'count', x.n) order by x.days desc)
      from (select coalesce(nullif(btrim(work_type), ''), 'All tasks') as type, round(avg(done_on - logged_on)::numeric, 1) as days, count(*) as n
        from delivered group by 1) x), '[]'),
    'average_revisions', (select round(avg(revision)::numeric, 2) from delivered),
    'open_by_status', coalesce((select jsonb_agg(jsonb_build_object('status', x.step, 'count', x.n) order by x.rank)
      from (select app.work_step(status, review_stage) as step, min(array_position(array['todo','progress','review','approved','blocked'],
        app.work_lane(status, review_stage))) as rank, count(*) as n from open_tasks group by 1) x), '[]'),
    'ageing', jsonb_build_object(
      'week', (select count(*) from open_tasks where _today - logged_on <= 7),
      'month', (select count(*) from open_tasks where _today - logged_on between 8 and 30),
      'quarter', (select count(*) from open_tasks where _today - logged_on between 31 and 90),
      'older', (select count(*) from open_tasks where _today - logged_on > 90)),
    'vendors', '[]'::jsonb));
end $$;

-- Search every task this person may see, newest first, and the deliverables on them.
create or replace function public.work_search(_query text)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public, app as $$
declare _q text := lower(btrim(coalesce(_query, ''))); _today date := app.ledger_today();
begin
  if length(_q) < 2 then return jsonb_build_object('tasks', '[]'::jsonb, 'deliverables', '[]'::jsonb); end if;
  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(app.work_card(x.task, _today) order by x.created_at desc, x.id) from (
      select t as task, t.created_at, t.id from public.tasks t where t.deleted_at is null
        and (strpos(lower(t.title), _q) > 0 or strpos(lower(coalesce(t.description, '')), _q) > 0
          or strpos(lower(array_to_string(t.tags, ' ')), _q) > 0)
      order by t.created_at desc limit 20) x), '[]'),
    'deliverables', coalesce((select jsonb_agg(x.item order by x.added_at desc) from (
      select jsonb_build_object('id', d.id, 'task_id', t.id, 'task_title', t.title, 'type', d.type, 'version', d.version, 'link', d.link,
        'used_where', d.used_where, 'added_at', d.added_at) as item, d.added_at
      from public.task_deliverables d join public.tasks t on t.id = d.task_id
      where d.deleted_at is null and t.deleted_at is null
        and (strpos(lower(coalesce(d.type, '')), _q) > 0 or strpos(lower(coalesce(d.version, '')), _q) > 0
          or strpos(lower(coalesce(d.used_where, '')), _q) > 0 or strpos(lower(t.title), _q) > 0)
      order by d.added_at desc limit 20) x), '[]'));
end $$;

-- ---------------------------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------------------------
revoke all on function app.work_lane(text,text), app.work_step(text,text), app.work_can_see_employee(uuid), app.work_card(public.tasks,date),
  app.work_schedule(), app.work_google(), app.work_report_data(uuid,text,date,date,date,boolean) from public, anon;
grant execute on function app.work_lane(text,text), app.work_step(text,text), app.work_can_see_employee(uuid), app.work_card(public.tasks,date),
  app.work_schedule(), app.work_google(), app.work_report_data(uuid,text,date,date,date,boolean) to authenticated;
revoke all on function public.work_home(), public.work_task(uuid), public.work_report(text,text,uuid), public.work_insights(uuid),
  public.work_search(text) from public, anon;
grant execute on function public.work_home(), public.work_task(uuid), public.work_report(text,text,uuid), public.work_insights(uuid),
  public.work_search(text) to authenticated;

comment on column public.tasks.review_stage is 'Review step while In Progress: Internal Review, Awaiting Approval, Revisions or Approved (0173). Cleared when the status moves on.';
comment on table public.task_help_log is 'Help and reviews given to colleagues (0173). Counted in reports; never a task on a board.';
notify pgrst, 'reload schema';
commit;
