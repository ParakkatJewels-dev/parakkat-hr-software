-- 0081 — Stop handing every signed-in user the whole organisation chart.
--
-- entities, zones, branches, departments and designations all read `using (true)`. Every other
-- table in this schema is scoped by app.has_perm; these five were left open because the interface
-- needs them for its placement dropdowns and nobody wanted an empty "Branch" picker.
--
-- The dropdowns were fixed on the client instead — lib/orgScope.js narrows the tree by the grants
-- you hold — but the ROWS still arrive. A branch manager's browser downloads every company, every
-- zone and every branch in the group and simply declines to draw them. That is a client-side
-- choice, and a client-side choice is not access control: the same request run by hand, or read
-- out of devtools, returns the lot.
--
-- WHY ENTITY GRANULARITY AND NOT FINER
-- The rule below is: you can read an organisation row if you hold a grant somewhere inside its
-- company, or if it is the company you work for. It deliberately does NOT narrow further to your
-- own zone or branch.
--
-- Narrower is where this gets dangerous. Placement forms need the parent list to file somebody
-- under — a branch manager adding an employee needs the entity's departments and designations, and
-- the Structure screen needs a whole company at once or it cannot show the tree it exists to show.
-- A rule that hides part of a company empties one of those pickers, and an empty picker is a
-- feature that silently stops working rather than an error anyone reports.
--
-- What this closes is the cross-company leak, which is the part that is nobody's business. What it
-- leaves is the shape of your own employer, visible to people who work there. orgScope.js still
-- narrows what the interface OFFERS, so this is a floor under that, not a replacement for it.
--
-- NOT JUST GRANTS — YOUR OWN RECORD
-- The last branch of readable_entity_ids is the one that is easy to leave out and impossible to
-- miss afterwards. A self-scoped employee holds no entity, zone, branch or department grant at all.
-- Without that branch their own profile loses its company, branch and department names: the
-- employees query embeds entity:entities(...) and friends, and an embed whose row is filtered by
-- RLS comes back null rather than failing. Every ESS user would see "—" where their posting is.

begin;

-- Which companies can the caller see any part of?
--
-- SECURITY DEFINER because it reads the very tables whose policies call it; without that the
-- lookup inside the policy would re-enter the policy. It returns nothing but entity ids, so the
-- elevated read is not a leak in itself.
create or replace function app.readable_entity_ids()
returns setof uuid
language sql
stable
security definer
set search_path = app, public
as $$
  -- A grant AT the company.
  select ra.scope_id
    from public.role_assignments ra
   where ra.user_id = auth.uid() and ra.scope_type = 'entity' and ra.scope_id is not null

  union

  -- A grant somewhere INSIDE it: the company a zone, branch or department belongs to is on the
  -- path to that grant, so it has to be readable or the grant cannot be displayed in context.
  select z.entity_id
    from public.zones z
    join public.role_assignments ra
      on ra.user_id = auth.uid() and ra.scope_type = 'zone' and ra.scope_id = z.id

  union

  select b.entity_id
    from public.branches b
    join public.role_assignments ra
      on ra.user_id = auth.uid() and ra.scope_type = 'branch' and ra.scope_id = b.id

  union

  select d.entity_id
    from public.departments d
    join public.role_assignments ra
      on ra.user_id = auth.uid() and ra.scope_type = 'department' and ra.scope_id = d.id

  union

  -- The company you work for. Self-scoped employees hold no org grant of any kind, and this is
  -- what keeps their own profile from losing its company, branch and department names.
  select emp.entity_id
    from public.profiles p
    join public.employees emp on emp.id = p.employee_id
   where p.user_id = auth.uid() and emp.entity_id is not null;
$$;

/**
 * May the caller read an organisation row belonging to `_entity`?
 *
 * A global grant is org-wide by definition, so it passes before the per-entity lookup — that is
 * also what keeps the Structure screen whole for an HR manager appointed across the group.
 */
create or replace function app.can_read_org(_entity uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.is_super_admin()
      or exists (
        select 1 from public.role_assignments ra
         where ra.user_id = auth.uid() and ra.scope_type = 'global'
      )
      or (_entity is not null and _entity in (select app.readable_entity_ids()));
$$;

grant execute on function app.readable_entity_ids() to authenticated;
grant execute on function app.can_read_org(uuid) to authenticated;

-- The five policies. Each names the company the row belongs to; entities are their own company.
drop policy if exists entities_read on public.entities;
create policy entities_read on public.entities
  for select to authenticated
  using (app.can_read_org(id));

drop policy if exists zones_read on public.zones;
create policy zones_read on public.zones
  for select to authenticated
  using (app.can_read_org(entity_id));

drop policy if exists branches_read on public.branches;
create policy branches_read on public.branches
  for select to authenticated
  using (app.can_read_org(entity_id));

drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments
  for select to authenticated
  using (app.can_read_org(entity_id));

-- Designations are job titles rather than places, but they are entity-owned and appear in the same
-- placement forms, so they follow the same rule. Anyone who can read the company can read the
-- titles available in it — a narrower rule here would empty the designation picker for exactly the
-- branch and department managers who use it.
drop policy if exists designations_read on public.designations;
create policy designations_read on public.designations
  for select to authenticated
  using (app.can_read_org(entity_id));

commit;
