-- 0046 — Tell the client what it may grant.
--
-- 0044 gave the database a seniority ladder, but the UI has no way to see it, so it would keep
-- offering every role in the dropdown and let the user discover the ceiling by hitting an RLS
-- error after filling in the form. Two additions fix that:
--
--   get_my_access().rank  — the caller's own ceiling, so the role list can be filtered client-side
--   roles.rank            — already readable (roles is granted to authenticated), so the client can
--                           compare directly
--
-- These are convenience only. can_grant remains the boundary: a client that ignores the rank still
-- gets refused by RLS.

begin;

create or replace function public.get_my_access()
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'is_super_admin', app.is_super_admin(),
    -- The caller's seniority. 1000 for a super admin, otherwise the highest-ranked role they hold.
    'rank', app.max_role_rank(),
    'employee', (
      select to_jsonb(e) from (
        select emp.id, emp.full_name, emp.email, emp.employee_code, emp.status,
               emp.entity_id, emp.zone_id, emp.branch_id, emp.department_id, emp.designation_id
        from public.profiles p
        join public.employees emp on emp.id = p.employee_id
        where p.user_id = auth.uid()
      ) e
    ),
    'assignments', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'role', r.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id))
      from public.role_assignments ra
      join public.roles r on r.id = ra.role_id
      where ra.user_id = auth.uid()
    ), '[]'::jsonb),
    'permissions', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
        'permission', p.key, 'scope_type', ra.scope_type, 'scope_id', ra.scope_id))
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid()
    ), '[]'::jsonb)
  ) into result;
  return result;
end $$;

grant execute on function public.get_my_access() to authenticated;

commit;
