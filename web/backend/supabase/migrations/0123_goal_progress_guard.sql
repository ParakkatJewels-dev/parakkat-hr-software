-- Self-service permits recording progress, not rewriting the target or hiding it from managers.
-- RLS restricts rows; this trigger restricts the columns a self-service update may change.
create or replace function app.tg_goal_progress_guard()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public, app as $$
begin
  if not app.has_perm('performance.manage', old.entity_id, old.zone_id,
      old.branch_id, old.department_id, old.employee_id) then
    if (to_jsonb(new) - array['progress', 'status', 'updated_at'])
        is distinct from (to_jsonb(old) - array['progress', 'status', 'updated_at']) then
      raise exception 'Only a manager can change a goal''s definition.' using errcode = '42501';
    end if;
    if new.status is distinct from old.status and (new.status = 'Dropped' or old.status = 'Dropped') then
      raise exception 'Only a manager can drop or reopen a dropped goal.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_goals_progress_guard on public.goals;
create trigger trg_goals_progress_guard before update on public.goals
  for each row execute function app.tg_goal_progress_guard();
revoke all on function app.tg_goal_progress_guard() from public, anon;
