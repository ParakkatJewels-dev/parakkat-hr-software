-- 0078 — A retired or lost asset cannot be handed to anybody.
--
-- WHAT 0076 LEFT OPEN
-- app.tg_asset_sync_holder sets status to 'Allocated' whenever an open assignment exists. It was
-- written to protect a deliberate status from being undone by a RETURN, and it does — but nothing
-- protected it from the ALLOCATION. So:
--
--   mark a laptop Retired  ->  allocate it  ->  status becomes 'Allocated', 'Retired' is gone
--                          ->  take it back ->  status becomes 'Available'
--
-- The register then shows a written-off machine as ordinary stock, and the fact that somebody
-- decided to retire it exists nowhere. Same for Lost: an asset reported missing could be quietly
-- allocated and would come back looking fine.
--
-- Found by running the custody flow against the database rather than reading the trigger: the
-- comment in 0076 claimed the deliberate status was safe, and for a return it is. The allocation
-- was the unguarded half.
--
-- WHY A GUARD RATHER THAN MORE STATUS ARITHMETIC
-- Preserving 'Retired' through an allocation would be worse, not better — it would leave a row
-- claiming to be both retired and held. These two states mean the asset is out of service, so the
-- correct answer is to refuse the handover and make somebody put it back into service first.
-- Under Repair and Damaged stay allocatable on purpose: lending a dented monitor is a real thing
-- to do, and the condition columns on the assignment record what shape it went out in.

begin;

create or replace function app.tg_asset_assignment_guard()
returns trigger language plpgsql security definer set search_path = app, public as $$
declare
  _status text;
  _name   text;
begin
  select a.status, a.name into _status, _name
    from public.assets a where a.id = new.asset_id;

  if _status in ('Retired', 'Lost') then
    raise exception
      '% is marked % and cannot be allocated. Change its status first if it is back in service.',
      coalesce(_name, 'That asset'), lower(_status)
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function app.tg_asset_assignment_guard() is
  'Refuses to open a custody row for an asset that is out of service. Fires only on INSERT, so '
  'closing an existing assignment always works — an asset already out with somebody must be '
  'returnable no matter what its status became while they had it.';

drop trigger if exists trg_asset_assignment_guard on public.asset_assignments;
create trigger trg_asset_assignment_guard
  before insert on public.asset_assignments
  for each row execute function app.tg_asset_assignment_guard();

commit;
