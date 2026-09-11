-- Revocation returns the deleted row so the client can distinguish success from a stale or
-- unauthorized assignment. PostgreSQL also applies SELECT RLS to DELETE ... RETURNING.
-- Let delegated administrators see exactly the grants they already may manage, using the same
-- grantee, rank and scope check as INSERT/UPDATE/DELETE; retain self visibility.
drop policy if exists role_assignments_select on public.role_assignments;
create policy role_assignments_select on public.role_assignments for select to authenticated
  using (user_id=auth.uid() or app.is_super_admin()
    or app.can_grant_to(user_id,role_id,scope_type,scope_id));
