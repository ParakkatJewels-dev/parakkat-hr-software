-- Nobody signs off their own request.
--
-- The RLS policies on leaves, expenses and attendance_regularizations are scope-based: they ask
-- whether the approver's scope covers the employee on the row. An approver's scope always covers
-- themselves — they are inside their own department — so hr_manager and entity_admin were both able
-- to file a request and then approve it, measured live. That is not a scope break; scope has no
-- opinion about who the requester is. It has to be stated separately.
--
-- Deliberately NOT a policy: RLS refusals on UPDATE surface as a silent zero-row no-op, so an
-- approval that was quietly dropped would look to the user like a button that did nothing. A
-- trigger can say why.
--
-- Super admin is exempt on purpose. This is a small company and the owner may be the only person
-- above the person requesting; a rule with no exit would eventually strand somebody's leave with
-- nobody able to approve it. If you would rather that were absolute, delete the is_super_admin()
-- clause below — everything else stays the same.
create or replace function app.tg_no_self_approval()
returns trigger language plpgsql security definer set search_path = app, public as $$
begin
  if new.status is distinct from old.status
     and new.status in ('Approved', 'Rejected')
     and old.status = 'Pending'
     and new.employee_id = app.current_employee_id()
     and not app.is_super_admin()
  then
    raise exception 'You cannot % your own request — someone else has to review it.',
      case new.status when 'Approved' then 'approve' else 'reject' end using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_leaves_no_self_approval on public.leaves;
create trigger trg_leaves_no_self_approval
  before update on public.leaves
  for each row execute function app.tg_no_self_approval();

drop trigger if exists trg_expenses_no_self_approval on public.expenses;
create trigger trg_expenses_no_self_approval
  before update on public.expenses
  for each row execute function app.tg_no_self_approval();

drop trigger if exists trg_regularizations_no_self_approval on public.attendance_regularizations;
create trigger trg_regularizations_no_self_approval
  before update on public.attendance_regularizations
  for each row execute function app.tg_no_self_approval();
