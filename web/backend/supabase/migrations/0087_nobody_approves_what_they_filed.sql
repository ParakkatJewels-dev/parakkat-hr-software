-- 0084 — One person cannot both file an expense and approve it.
--
-- 0072 stopped you approving your OWN claim: the guard compares new.employee_id against
-- app.current_employee_id(). That covers the obvious case and misses the one that actually moves
-- money without a second pair of eyes — filing a claim on somebody ELSE'S behalf and approving it.
-- expenses_insert admits anyone holding expense.create over the target's scope, expenses_update
-- anyone holding expense.approve over the same scope, and a manager typically holds both. The row
-- that comes out has a different employee_id from the approver, so 0072's check never fires.
--
-- MY OWN 0080 WIDENED THIS. Its note records that manager roles did not hold expense.create —
-- "those sat on `employee` alone" — and it granted them, so a manager could file their own claim.
-- They already held expense.approve. That combination is the hole, and this migration is the other
-- half of that change rather than a fix to somebody else's work.
--
-- WHY A NEW COLUMN
-- The table records whose expense it is (employee_id) and, in principle, who approved it
-- (approver_id — never actually written, see the data hook fixed alongside this). It has never
-- recorded who FILED it, so "the filer may not approve" was not a rule the database could state.
-- created_by is that missing fact. Defaulted from auth.uid() so it is captured without every
-- caller remembering, and left nullable because 130-odd historical rows genuinely do not know.
--
-- Historical rows keep created_by null and are therefore not blocked by the guard below. Refusing
-- to approve every pending claim filed before today would be a rule applied retroactively to
-- people who could not have known it, and the audit log already holds who inserted them.

begin;

alter table public.expenses
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.expenses
  alter column created_by set default auth.uid();

comment on column public.expenses.created_by is
  'Who filed the claim, as distinct from employee_id (whose claim it is) and approver_id (who decided it). Exists so the database can refuse to let one person do two of those three.';

create index if not exists expenses_created_by_idx on public.expenses (created_by);

/**
 * Refuse a decision by the person who requested it — or, for expenses, by the person who filed it.
 *
 * Two separate conditions, because they catch different things:
 *
 *   employee_id = me   the claim is mine, whoever typed it in       (0072's rule, unchanged)
 *   created_by  = me   I typed it in, whoever it is for             (new)
 *
 * Super admins stay exempt. That is deliberate and was 0072's call: a rule with no exit strands a
 * claim forever when the only person senior enough to decide it is the one who raised it. The audit
 * log records the decision either way.
 *
 * Applies to leaves and regularizations too, which have no created_by — `to_jsonb(new) ? 'created_by'`
 * makes the second condition simply not apply there rather than erroring on a missing field.
 */
create or replace function app.tg_no_self_approval()
returns trigger
language plpgsql
security definer
set search_path = app, public
as $$
declare
  _filed_by uuid;
begin
  if new.status is distinct from old.status
     and new.status in ('Approved', 'Rejected')
     and old.status = 'Pending'
     and not app.is_super_admin()
  then
    if new.employee_id = app.current_employee_id() then
      raise exception 'You cannot % your own request — someone else has to review it.',
        case new.status when 'Approved' then 'approve' else 'reject' end using errcode = '42501';
    end if;

    if to_jsonb(new) ? 'created_by' then
      _filed_by := (to_jsonb(new) ->> 'created_by')::uuid;
      if _filed_by is not null and _filed_by = auth.uid() then
        raise exception 'You filed this claim, so you cannot % it — someone else has to review it.',
          case new.status when 'Approved' then 'approve' else 'reject' end using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end $$;

commit;
