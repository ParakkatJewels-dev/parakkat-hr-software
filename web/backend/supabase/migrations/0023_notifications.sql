-- 0023_notifications.sql
-- In-app notifications. Rows are created ONLY by database triggers on the module tables
-- (leaves, expenses, tasks, attendance_regularizations, tickets), so a change made from the
-- web app, the mobile app, or the SQL editor all produce the same notification. Each row
-- targets one auth user; RLS lets a user see and update (mark read) only their own rows.
-- The table streams over Supabase Realtime like the other operational tables (see 0022).
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- table
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null,          -- leave / expense / task / regularization / ticket
  title      text not null,
  body       text,
  tab        text,                   -- app tab to open when clicked (matches App.jsx tab ids)
  ref_id     uuid,                   -- id of the row that caused the notification
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user   on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_unread on public.notifications(user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- RLS: read/update/delete own rows only. No INSERT policy or grant — clients
-- cannot fabricate notifications; the security-definer helpers below insert.
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());

grant select, update, delete on public.notifications to authenticated;

-- ---------------------------------------------------------------------------
-- realtime (same pattern as 0022)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
  alter table public.notifications replica identity full;
end $$;

-- ---------------------------------------------------------------------------
-- insert helpers (security definer: bypass RLS; only reachable via triggers)
-- ---------------------------------------------------------------------------

-- Notify one auth user. Skips silently when the target is null (employee has no login)
-- or the target is the acting user (no self-notifications).
create or replace function app.notify_user(
  _user uuid, _type text, _title text, _body text, _tab text, _ref uuid
) returns void language plpgsql security definer set search_path = app, public as $$
begin
  if _user is null or _user = auth.uid() then return; end if;
  insert into public.notifications (user_id, type, title, body, tab, ref_id)
  values (_user, _type, _title, _body, _tab, _ref);
end $$;

-- Notify every user who holds `_perm` over the given ancestry at a beyond-self scope
-- (the approvers/managers for that row), plus super admins. Excludes the acting user.
create or replace function app.notify_perm_holders(
  _perm text, _entity uuid, _zone uuid, _branch uuid, _dept uuid,
  _type text, _title text, _body text, _tab text, _ref uuid
) returns void language plpgsql security definer set search_path = app, public as $$
begin
  insert into public.notifications (user_id, type, title, body, tab, ref_id)
  select distinct u.user_id, _type, _title, _body, _tab, _ref
  from (
    select ra.user_id
    from public.role_assignments ra
    join public.role_permissions rp on rp.role_id = ra.role_id
    join public.permissions p on p.id = rp.permission_id
    where p.key = _perm
      and (
           ra.scope_type = 'global'
        or (ra.scope_type = 'entity'     and ra.scope_id = _entity)
        or (ra.scope_type = 'zone'       and ra.scope_id = _zone)
        or (ra.scope_type = 'branch'     and ra.scope_id = _branch)
        or (ra.scope_type = 'department' and ra.scope_id = _dept)
      )
    union
    select pr.user_id from public.profiles pr where pr.is_super_admin
  ) u
  where u.user_id is not null
    and (auth.uid() is null or u.user_id <> auth.uid());
end $$;

-- ---------------------------------------------------------------------------
-- module triggers
-- ---------------------------------------------------------------------------

-- leaves: request -> approvers; decision -> requester
create or replace function app.tg_notify_leave()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _name text; _emp_user uuid; _range text;
begin
  select e.full_name, e.user_id into _name, _emp_user
  from public.employees e where e.id = new.employee_id;
  _range := to_char(new.start_date, 'DD Mon') || ' – ' || to_char(new.end_date, 'DD Mon');

  if tg_op = 'INSERT' and new.status = 'Pending' then
    perform app.notify_perm_holders('leave.approve',
      new.entity_id, new.zone_id, new.branch_id, new.department_id,
      'leave', 'New leave request',
      coalesce(_name, 'An employee') || ' requested ' || coalesce(new.days::text, '?')
        || ' day(s) of ' || new.type || ' leave (' || _range || ').',
      'leave', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status
        and new.status in ('Approved', 'Rejected', 'Cancelled') then
    perform app.notify_user(_emp_user, 'leave',
      'Leave ' || lower(new.status),
      'Your ' || new.type || ' leave (' || _range || ') was ' || lower(new.status) || '.',
      'leave', new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_leaves_notify on public.leaves;
create trigger trg_leaves_notify
  after insert or update of status on public.leaves
  for each row execute function app.tg_notify_leave();

-- expenses: submitted -> approvers; decision/payment -> owner
create or replace function app.tg_notify_expense()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _name text; _emp_user uuid; _amount text;
begin
  select e.full_name, e.user_id into _name, _emp_user
  from public.employees e where e.id = new.employee_id;
  _amount := '₹' || trim(to_char(new.amount, '9,99,99,990.99'));

  if new.status = 'Pending'
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform app.notify_perm_holders('expense.approve',
      new.entity_id, new.zone_id, new.branch_id, new.department_id,
      'expense', 'New expense claim',
      coalesce(_name, 'An employee') || ' submitted a ' || coalesce(new.category, 'general')
        || ' expense of ' || _amount || ' for approval.',
      'expense', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status
        and new.status in ('Approved', 'Rejected', 'Paid') then
    perform app.notify_user(_emp_user, 'expense',
      'Expense ' || lower(new.status),
      'Your ' || coalesce(new.category, 'general') || ' expense of ' || _amount
        || ' was ' || lower(new.status) || '.',
      'expense', new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_expenses_notify on public.expenses;
create trigger trg_expenses_notify
  after insert or update of status on public.expenses
  for each row execute function app.tg_notify_expense();

-- tasks: assignment -> assignee; status change -> the other party
create or replace function app.tg_notify_task()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _assignee_user uuid; _assigner_user uuid; _assigner_name text;
begin
  select e.user_id into _assignee_user from public.employees e where e.id = new.employee_id;
  select e.user_id, e.full_name into _assigner_user, _assigner_name
  from public.employees e where e.id = new.assigned_by;

  if tg_op = 'INSERT'
     or (tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id) then
    perform app.notify_user(_assignee_user, 'task',
      'New task assigned',
      '"' || new.title || '"'
        || case when _assigner_name is not null then ' — assigned by ' || _assigner_name else '' end
        || case when new.due_date is not null then ' (due ' || to_char(new.due_date, 'DD Mon') || ')' else '' end || '.',
      'tasks', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- notify_user skips the actor, so only the counterpart actually gets a row
    perform app.notify_user(_assignee_user, 'task',
      'Task ' || case when new.status = 'Done' then 'completed' else 'updated' end,
      '"' || new.title || '" is now ' || new.status || '.',
      'tasks', new.id);
    perform app.notify_user(_assigner_user, 'task',
      'Task ' || case when new.status = 'Done' then 'completed' else 'updated' end,
      '"' || new.title || '" is now ' || new.status || '.',
      'tasks', new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_notify on public.tasks;
create trigger trg_tasks_notify
  after insert or update of status, employee_id on public.tasks
  for each row execute function app.tg_notify_task();

-- attendance regularizations: request -> approvers; decision -> requester
create or replace function app.tg_notify_regularization()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _name text; _emp_user uuid;
begin
  select e.full_name, e.user_id into _name, _emp_user
  from public.employees e where e.id = new.employee_id;

  if tg_op = 'INSERT' and new.status = 'Pending' then
    perform app.notify_perm_holders('regularization.approve',
      new.entity_id, new.zone_id, new.branch_id, new.department_id,
      'regularization', 'Attendance regularization request',
      coalesce(_name, 'An employee') || ' requested regularization for '
        || to_char(new.work_date, 'DD Mon YYYY') || '.',
      'attendance', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status
        and new.status in ('Approved', 'Rejected') then
    perform app.notify_user(_emp_user, 'regularization',
      'Regularization ' || lower(new.status),
      'Your attendance regularization for ' || to_char(new.work_date, 'DD Mon YYYY')
        || ' was ' || lower(new.status) || '.'
        || case when new.decision_note is not null then ' Note: ' || new.decision_note else '' end,
      'attendance', new.id);
  end if;
  return new;
end $$;

drop trigger if exists trg_regularizations_notify on public.attendance_regularizations;
create trigger trg_regularizations_notify
  after insert or update of status on public.attendance_regularizations
  for each row execute function app.tg_notify_regularization();

-- tickets: raised -> support (ticket.manage); status change or assignment -> owner/assignee
create or replace function app.tg_notify_ticket()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _name text; _emp_user uuid; _assignee_user uuid;
begin
  select e.full_name, e.user_id into _name, _emp_user
  from public.employees e where e.id = new.employee_id;

  if tg_op = 'INSERT' then
    perform app.notify_perm_holders('ticket.manage',
      new.entity_id, new.zone_id, new.branch_id, new.department_id,
      'ticket', 'New helpdesk ticket',
      coalesce(_name, 'An employee') || ' raised: "' || new.subject || '".',
      'helpdesk', new.id);
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      perform app.notify_user(_emp_user, 'ticket',
        'Ticket ' || lower(new.status),
        'Your ticket "' || new.subject || '" is now ' || new.status || '.',
        'helpdesk', new.id);
    end if;
    if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
      select e.user_id into _assignee_user from public.employees e where e.id = new.assigned_to;
      perform app.notify_user(_assignee_user, 'ticket',
        'Ticket assigned to you',
        '"' || new.subject || '" (' || coalesce(new.priority, 'Medium') || ' priority).',
        'helpdesk', new.id);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_tickets_notify on public.tickets;
create trigger trg_tickets_notify
  after insert or update of status, assigned_to on public.tickets
  for each row execute function app.tg_notify_ticket();
