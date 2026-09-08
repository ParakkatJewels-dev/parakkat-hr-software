-- 0098_a_notification_points_at_the_row.sql
--
-- Two things a notification already knew and never said.
--
-- 1. WHICH TAB. Attendance is four screens behind one route — today, calendar, exceptions and
--    regularizations (see TABS in Attendance.jsx, and urlTab.js, which reads the second path
--    segment as a page's inner tab). Both regularization notifications wrote the tab as plain
--    `attendance`, so "Regularization approved" opened the screen's DEFAULT tab and left the reader
--    to find the Regularizations one themselves. `attendance/regularizations` routes to it directly;
--    setActiveTab does navigate('/' || tab), so no application change is needed for this to work.
--
-- 2. WHICH ROW. `ref_id` has always held the id of the request, task or ticket the notification is
--    about, and the click handler discarded it. It is now read on the client and appended as
--    `?focus=<ref_id>` (see web/src/lib/focusRow.js), so the target screen pages to the row,
--    scrolls it into view and marks it. That needs no schema change — only that `tab` names a
--    route that actually shows the row, which is what fix 1 above is.
--
-- Nothing about the notifications TABLE changes; this only re-creates the trigger function so new
-- rows carry the better tab. Existing rows keep the tab they were written with and still work —
-- they simply land on the default attendance tab as before.
--
-- Idempotent: safe to re-run.

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
      'attendance/regularizations', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status
        and new.status in ('Approved', 'Rejected') then
    perform app.notify_user(_emp_user, 'regularization',
      'Regularization ' || lower(new.status),
      'Your attendance regularization for ' || to_char(new.work_date, 'DD Mon YYYY')
        || ' was ' || lower(new.status) || '.'
        || case when new.decision_note is not null then ' Note: ' || new.decision_note else '' end,
      'attendance/regularizations', new.id);
  end if;
  return new;
end $$;

-- The trigger itself is unchanged (0023 created it); re-assert it so a fresh database that runs
-- only the later migrations still ends up wired.
drop trigger if exists trg_regularizations_notify on public.attendance_regularizations;
create trigger trg_regularizations_notify
  after insert or update of status on public.attendance_regularizations
  for each row execute function app.tg_notify_regularization();

-- Old rows still point at the bare screen. Move the ones that have not been read yet, so anything
-- still demanding attention benefits; read ones are history and are left exactly as they were.
update public.notifications
   set tab = 'attendance/regularizations'
 where type = 'regularization'
   and tab = 'attendance'
   and read_at is null;
