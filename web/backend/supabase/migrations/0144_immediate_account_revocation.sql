-- An existing JWT loses HRMS access on the next database statement after an account is
-- disabled/banned/deleted. No token refresh is needed. Unlinked administrative logins remain
-- valid; a linked employee must be Active. Trusted service/owner jobs retain their existing path.
begin;

create or replace function app.account_is_active(_user uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select _user is not null
    and exists(select 1 from auth.users u where u.id=_user and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now()))
    and not exists(select 1 from public.employees e
      where e.status is distinct from 'Active' and (e.user_id=_user or e.id in
        (select p.employee_id from public.profiles p where p.user_id=_user)));
$$;
revoke all on function app.account_is_active(uuid) from public,anon,authenticated,service_role;
-- Attendance workers use service_role to revalidate the queued actor immediately before work.
grant usage on schema app to service_role;
grant execute on function app.account_is_active(uuid) to service_role;

create or replace function app.session_is_active()
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.account_is_active(auth.uid());
$$;
revoke all on function app.session_is_active() from public;
grant execute on function app.session_is_active() to anon,authenticated,service_role;

-- Core permission and identity helpers run as owner to avoid recursive RLS. Each therefore
-- checks account state itself; filtering only role_assignments would not protect these reads.

create or replace function app.is_super_admin()
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.session_is_active() and (
coalesce((select is_super_admin from public.profiles where user_id = auth.uid()), false)
      or exists (
        select 1 from public.role_assignments ra
        join public.roles r on r.id = ra.role_id
        where ra.user_id = auth.uid() and r.key = 'super_admin' and ra.scope_type = 'global'
      )
  );
$$;

create or replace function app.has_perm(
  _perm text, _entity uuid, _zone uuid, _branch uuid, _dept uuid, _employee uuid
) returns boolean language sql stable security definer set search_path = app, public as $$
  select app.session_is_active() and (
app.is_super_admin()
    or exists (
      select 1
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid()
        and p.key = _perm
        and (
             ra.scope_type = 'global'
          or (ra.scope_type = 'entity'     and ra.scope_id = _entity)
          or (ra.scope_type = 'zone'       and ra.scope_id = _zone)
          or (ra.scope_type = 'branch'     and ra.scope_id = _branch)
          or (ra.scope_type = 'department' and ra.scope_id = _dept)
          or (ra.scope_type = 'self'       and _employee is not null and _employee = app.current_employee_id())
        )
    )
  );
$$;

create or replace function app.has_perm_any_scope(_perm text)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.session_is_active() and (
app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid() and p.key = _perm
      )
  );
$$;

create or replace function app.has_perm_org_wide(_perm text)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.session_is_active() and (
app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid()
           and p.key = _perm
           and ra.scope_type in ('global', 'entity')
      )
  );
$$;

create or replace function app.has_perm_at_branch_or_wider(_perm text)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.session_is_active() and (
app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid()
           and p.key = _perm
           and ra.scope_type in ('global', 'entity', 'zone', 'branch')
      )
  );
$$;

create or replace function app.has_perm_globally(_perm text)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.session_is_active() and (
app.is_super_admin()
      or exists (
        select 1
          from public.role_assignments ra
          join public.role_permissions rp on rp.role_id = ra.role_id
          join public.permissions p on p.id = rp.permission_id
         where ra.user_id = auth.uid()
           and p.key = _perm
           and ra.scope_type = 'global'
      )
  );
$$;

create or replace function app.can_read_org(_entity uuid)
returns boolean
language sql
stable
security definer
set search_path = app, public
as $$
  select app.session_is_active() and (
app.is_super_admin()
      or exists (
        select 1 from public.role_assignments ra
         where ra.user_id = auth.uid() and ra.scope_type = 'global'
      )
      or (_entity is not null and _entity in (select app.readable_entity_ids()))
  );
$$;

create or replace function app.can_request_help_in(_entity uuid)
returns boolean language sql stable security definer set search_path = app, public as $$
  select app.session_is_active() and (
app.is_super_admin()
    or exists (
      select 1
        from public.role_assignments ra
        join public.role_permissions rp on rp.role_id = ra.role_id
        join public.permissions p on p.id = rp.permission_id
        left join public.departments d on ra.scope_type = 'department' and d.id = ra.scope_id
        left join public.branches    b on ra.scope_type = 'branch'     and b.id = ra.scope_id
        left join public.zones       z on ra.scope_type = 'zone'       and z.id = ra.scope_id
       where ra.user_id = auth.uid()
         and p.key = 'task.request'
         and (
              ra.scope_type = 'global'
           or (ra.scope_type = 'entity'     and ra.scope_id  = _entity)
           or (ra.scope_type = 'zone'       and z.entity_id  = _entity)
           or (ra.scope_type = 'branch'     and b.entity_id  = _entity)
           or (ra.scope_type = 'department' and d.entity_id  = _entity)
         )
    )
  );
$$;

create or replace function app.current_employee_id()
returns uuid language sql stable security definer set search_path = app, public as $$
  select employee_id from public.profiles where user_id = auth.uid() and app.session_is_active()
$$;

create or replace function app.visible_branch_ids()
returns setof uuid language sql stable security definer set search_path = app, public as $$
  select allowed.* from (
select b.id from public.branches b
  where app.is_super_admin()
     or exists (
       select 1 from public.role_assignments ra
       where ra.user_id = auth.uid() and (
            ra.scope_type = 'global'
         or (ra.scope_type = 'entity' and ra.scope_id = b.entity_id)
         or (ra.scope_type = 'zone'   and ra.scope_id = b.zone_id)
         or (ra.scope_type = 'branch' and ra.scope_id = b.id)
       )
     )
  ) allowed where app.session_is_active();
$$;

create or replace function app.readable_entity_ids()
returns setof uuid
language sql
stable
security definer
set search_path = app, public
as $$
  select allowed.* from (
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
   where p.user_id = auth.uid() and emp.entity_id is not null
  ) allowed where app.session_is_active();
$$;

create or replace function app.max_role_rank()
returns int language sql stable security definer set search_path = app, public as $$
  select case when app.session_is_active() then (
select case
    when app.is_super_admin() then 1000
    else coalesce((
      select max(r.rank)
        from public.role_assignments ra
        join public.roles r on r.id = ra.role_id
       where ra.user_id = auth.uid()
    ), 0)
  end
  ) else 0 end;
$$;

create or replace function app.max_grantable_rank()
returns int language sql stable security definer set search_path = app, public as $$
  select case when app.session_is_active() then (
select case
    when app.is_super_admin() then 1000
    when app.max_role_rank() <= 60
     and exists (
           select 1
             from public.role_assignments ra
             join public.roles r on r.id = ra.role_id
            where ra.user_id = auth.uid() and r.key = 'hr_manager'
         )
    then 30
    else app.max_role_rank() - 1
  end
  ) else 0 end;
$$;

create or replace function app.can_grant(_role_id uuid, _scope_type public.scope_type, _scope_id uuid)
returns boolean language plpgsql stable security definer set search_path = app, public as $$
declare
  _key  text;
  _rank int;
  _sys  boolean;
  _e uuid; _z uuid; _b uuid; _d uuid;
  _admin_role boolean;
begin
  if not app.session_is_active() then return false; end if;
  if app.is_super_admin() then return true; end if;

  select key, rank, is_system into _key, _rank, _sys from public.roles where id = _role_id;
  if _key is null then return false; end if;

  select exists (
    select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
     where rp.role_id = _role_id and p.key in ('rbac.manage','org.manage')
  ) into _admin_role;

  -- ESS convenience: employee@self may be granted/revoked by an rbac.manage holder, with
  -- app.can_grant_to constraining the grantee to the caller's scope.
  if _key = 'employee' and _scope_type = 'self' then
    return exists (
      select 1
      from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id
      where ra.user_id = auth.uid() and p.key = 'rbac.manage'
    );
  end if;

  if _key = 'super_admin' or _scope_type in ('global', 'self') then
    return false;
  end if;

  if _rank > app.max_grantable_rank() then
    return false;
  end if;

  -- Custom administrative roles are outside the built-in rank ladder, so passing one on still needs
  -- entity-admin seniority. Built-in manager roles are already ordered by rank and handled above.
  if _admin_role and not coalesce(_sys, false) and app.max_role_rank() < 80 then
    return false;
  end if;

  if _scope_type = 'entity' then
    _e := _scope_id;
  elsif _scope_type = 'zone' then
    select entity_id into _e from public.zones where id = _scope_id;
    _z := _scope_id;
  elsif _scope_type = 'branch' then
    select entity_id, zone_id into _e, _z from public.branches where id = _scope_id;
    _b := _scope_id;
  elsif _scope_type = 'department' then
    select d.entity_id, b.zone_id, d.branch_id into _e, _z, _b
    from public.departments d
    left join public.branches b on b.id = d.branch_id
    where d.id = _scope_id;
    _d := _scope_id;
  end if;

  return app.has_perm('rbac.manage', _e, _z, _b, _d, null);
end $$;

-- Shared explicit-user helpers also govern leave reviewers, ticket routing and developer
-- API-key owners. Inactive staff cannot continue using a key created while they were active.
create or replace function app.ticket_actor_active(_user uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.account_is_active(_user);
$$;
create or replace function app.routine_actor_active()
returns boolean language sql stable security definer set search_path=pg_catalog,public,app as $$
  select app.session_is_active();
$$;

create or replace function app.developer_admin_active(_user uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select app.account_is_active(_user) and (
exists (
    select 1 from auth.users u join public.profiles p on p.user_id = u.id
    where u.id = _user and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and (p.is_super_admin or exists (
        select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
        where ra.user_id = u.id and r.key = 'super_admin' and ra.scope_type = 'global'
      ))
  )
  );
$$;

create or replace function app.leave_has_review_role(_user uuid, _roles text[], _leave public.leaves)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.account_is_active(_user) and (
_user is not null
    and exists (select 1 from auth.users u where u.id = _user and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now()))
    and not exists (select 1 from public.profiles p join public.employees e on e.id = p.employee_id
      where p.user_id = _user and e.status <> 'Active')
    and exists (
      select 1 from public.role_assignments ra
      join public.roles r on r.id = ra.role_id
      join public.role_permissions rp on rp.role_id = r.id
      join public.permissions p on p.id = rp.permission_id and p.key = 'leave.approve'
      where ra.user_id = _user and r.key = any(_roles)
        and (r.key <> 'super_admin' or ra.scope_type = 'global') and (
        ra.scope_type = 'global'
        or (ra.scope_type = 'entity' and ra.scope_id = _leave.entity_id)
        or (ra.scope_type = 'zone' and ra.scope_id = _leave.zone_id)
        or (ra.scope_type = 'branch' and ra.scope_id = _leave.branch_id)
        or (ra.scope_type = 'department' and ra.scope_id = _leave.department_id)
      )
    )
  );
$$;

create or replace function app.leave_reviewer(_user uuid, _stage text, _leave public.leaves)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.account_is_active(_user) and (
_user is not null
    and not exists (select 1 from public.profiles p where p.user_id = _user and p.employee_id = _leave.employee_id)
    and not exists (select 1 from public.employees e where e.id = _leave.employee_id and e.user_id = _user)
    and case _stage
      when 'department' then _leave.department_id is not null
        and app.leave_has_review_role(_user, array['dept_head'], _leave)
      when 'hr' then app.leave_has_review_role(_user, array['hr_manager','entity_admin','super_admin'], _leave)
        or exists (select 1 from public.profiles p join auth.users u on u.id = p.user_id
          where p.user_id = _user and p.is_super_admin and u.deleted_at is null
            and (u.banned_until is null or u.banned_until <= now())
            and not exists (select 1 from public.employees e where e.id = p.employee_id and e.status <> 'Active'))
      else false
    end
  );
$$;

-- These entry points have a direct identity read/early return before consulting scope.
-- get_my_access uses a recognizable 42501 so the browser can remove cached private data.

create or replace function public.get_my_access()
returns jsonb language plpgsql stable security definer set search_path = app, public as $$
declare result jsonb;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select jsonb_build_object(
    'is_super_admin', app.is_super_admin(),
    'rank', app.max_role_rank(),
    'must_change_password', coalesce(
      (select p.must_change_password from public.profiles p where p.user_id = auth.uid()), false),
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
    ), '[]'::jsonb),
    'hidden_screens', case
      when app.is_super_admin() then '[]'::jsonb
      else coalesce((
        select jsonb_agg(o.screen_id order by o.screen_id)
        from public.user_screen_overrides o
        where o.user_id = auth.uid()
      ), '[]'::jsonb)
    end
  ) into result;
  return result;
end $$;

create or replace function public.provision_employee_login(
  _employee_id uuid,
  _role_key    text default 'employee'
) returns jsonb
language plpgsql security definer set search_path = app, public as $$
declare
  _email    text;
  _password text;
  _existing uuid;
  _result   jsonb;
begin
  if auth.uid() is not null and not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select u.id into _existing
    from public.profiles p join auth.users u on u.id = p.user_id
   where p.employee_id = _employee_id;

  _email := app.derive_login_email(_employee_id);

  if _existing is not null then
    return jsonb_build_object(
      'created', false,
      'email', (select email from auth.users where id = _existing),
      'password', null,
      'note', 'This employee already has a login. Their password is unchanged.'
    );
  end if;

  _password := app.derive_login_password(_employee_id);

  _result := public.grant_app_access(
    _employee_id, _email, _password,
    _role_key,
    case when _role_key = 'employee' then 'self'::public.scope_type else 'entity'::public.scope_type end,
    case when _role_key = 'employee' then null
         else (select entity_id from public.employees where id = _employee_id) end
  );

  return jsonb_build_object(
    'created', true,
    'email', _email,
    'password', _password,
    'grant', _result,
    'note', 'Read these out once. They will be asked to choose their own password when they sign in.'
  );
end $$;

create or replace function public.asset_for_object(object_name text)
returns setof public.assets language sql stable security definer set search_path=pg_catalog,public,app as $$
  select a.* from public.assets a
  where app.session_is_active() and a.id=nullif(split_part(object_name,'/',1),'')::uuid
    and (app.has_perm('asset.read',a.entity_id,a.zone_id,a.branch_id,a.department_id,a.employee_id)
      or app.has_perm('asset.manage',a.entity_id,a.zone_id,a.branch_id,a.department_id,a.employee_id)
      or (a.entity_id is null and (app.has_perm_globally('asset.read') or app.has_perm_globally('asset.manage'))));
$$;

-- Deny before any existence/status check or no-op return can expose a private row.

create or replace function public.move_employee_to_department(_employee uuid, _department uuid)
returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  _emp_entity uuid; _emp_branch uuid; _emp_dept uuid; _emp_status text;
  _dest_entity uuid; _dest_branch uuid;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select e.entity_id, e.branch_id, e.department_id, e.status
    into _emp_entity, _emp_branch, _emp_dept, _emp_status
  from public.employees e where e.id = _employee;

  if _emp_entity is null then
    raise exception 'That employee does not exist.' using errcode = '42704';
  end if;
  if _emp_status is distinct from 'Active' then
    raise exception 'Only an active employee can be moved between departments.' using errcode = '42501';
  end if;
  if _emp_dept is not distinct from _department then
    return;   -- already there; nothing to do and nothing to log
  end if;

  if _department is null then
    -- Removing from a team: you must run the team they are leaving.
    if not app.has_perm('employee.assign', _emp_entity, null, _emp_branch, _emp_dept, null) then
      raise exception 'You cannot remove that person from their department.' using errcode = '42501';
    end if;
  else
    select d.entity_id, d.branch_id into _dest_entity, _dest_branch
    from public.departments d where d.id = _department;

    if _dest_entity is null then
      raise exception 'That department does not exist.' using errcode = '42704';
    end if;
    -- Four separate registered companies. A cross-company move is a payroll and tax decision.
    if _dest_entity is distinct from _emp_entity then
      raise exception 'That person belongs to a different company. Ask HR to move them.' using errcode = '42501';
    end if;
    if not app.has_perm('employee.assign', _dest_entity, null, _dest_branch, _department, null) then
      raise exception 'You cannot add people to that department.' using errcode = '42501';
    end if;
  end if;

  -- The one column. trg_employees_ancestry restamps entity/zone from it; trg_audit records that
  -- the row changed; department_moves records what it changed FROM.
  update public.employees set department_id = _department, updated_at = now()
   where id = _employee;

  insert into public.department_moves
    (employee_id, from_department_id, to_department_id, entity_id, branch_id, moved_by)
  values (_employee, _emp_dept, _department, _emp_entity, _emp_branch, auth.uid());
end $$;

create or replace function public.update_help_request(
  _request     uuid,
  _title       text default null,
  _description text default null,
  _priority    text default null,
  _due_date    date default null,
  _preferred   uuid default null,
  _clear_preferred boolean default false,
  _clear_due       boolean default false
) returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record; _pref_dept uuid;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'That request has already been %; it cannot be changed now.', lower(_r.status) using errcode = '22023';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'That is not your request to change.' using errcode = '42501';
  end if;

  if _title is not null and coalesce(btrim(_title),'') = '' then
    raise exception 'A request needs a title.' using errcode = '22023';
  end if;
  if _priority is not null and _priority not in ('Low','Medium','High','Urgent') then
    raise exception 'That is not a priority.' using errcode = '22023';
  end if;
  if _preferred is not null then
    select department_id into _pref_dept from public.employees where id = _preferred and status = 'Active';
    if _pref_dept is distinct from _r.to_department_id then
      raise exception 'That person is not in the department you are asking.' using errcode = '22023';
    end if;
  end if;

  -- Null means "leave it alone"; the explicit clear flags exist because null cannot mean both
  -- "unchanged" and "remove it".
  update public.help_requests
     set title       = coalesce(btrim(_title), title),
         description = case when _description is null then description
                            else nullif(btrim(_description), '') end,
         priority    = coalesce(_priority, priority),
         due_date    = case when _clear_due then null else coalesce(_due_date, due_date) end,
         preferred_employee_id = case when _clear_preferred then null
                                      else coalesce(_preferred, preferred_employee_id) end
   where id = _request;
end $$;

create or replace function public.update_requested_task(
  _task        uuid,
  _title       text default null,
  _description text default null,
  _priority    text default null,
  _due_date    date default null,
  _clear_due   boolean default false
) returns void
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select hr.* into _r from public.help_requests hr where hr.task_id = _task;
  if _r.id is null then
    raise exception 'That task did not come from a request.' using errcode = '42704';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'You did not ask for that work.' using errcode = '42501';
  end if;
  if _title is not null and coalesce(btrim(_title),'') = '' then
    raise exception 'A task needs a title.' using errcode = '22023';
  end if;
  if _priority is not null and _priority not in ('Low','Medium','High','Urgent') then
    raise exception 'That is not a priority.' using errcode = '22023';
  end if;

  update public.tasks
     set title       = coalesce(btrim(_title), title),
         description = case when _description is null then description
                            else nullif(btrim(_description), '') end,
         priority    = coalesce(_priority, priority),
         due_date    = case when _clear_due then null else coalesce(_due_date, due_date) end
   where id = _task;

  -- Keep the request reading the same as the work, so the two heads are looking at one thing.
  update public.help_requests
     set title = coalesce(btrim(_title), title),
         description = case when _description is null then description else nullif(btrim(_description), '') end,
         priority = coalesce(_priority, priority),
         due_date = case when _clear_due then null else coalesce(_due_date, due_date) end
   where id = _r.id;

  -- The person holding it should hear that what they were asked for has changed.
  perform app.notify_user(
    (select e.user_id from public.employees e where e.id = _r.assigned_employee_id),
    'task', 'A task you were given has changed',
    '"' || coalesce(btrim(_title), _r.title) || '" was updated by the department that asked for it.',
    'tasks', _task);
end $$;

create or replace function public.respond_to_help_request(
  _request  uuid,
  _accept   boolean,
  _assignee uuid default null,
  _note     text default null,
  _priority text default null
) returns uuid
language plpgsql security definer set search_path = public, app, pg_temp as $$
declare
  _r record; _me uuid; _task uuid; _assignee_dept uuid; _requester_user uuid; _final_priority text;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'That request has already been %.', lower(_r.status) using errcode = '22023';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.to_branch_id, _r.to_department_id, null) then
    raise exception 'That request was not addressed to you.' using errcode = '42501';
  end if;

  select employee_id into _me from public.profiles where user_id = auth.uid();

  if not _accept then
    update public.help_requests
       set status = 'Declined', decided_by = _me, decided_at = now(),
           decision_note = nullif(btrim(coalesce(_note,'')),'')
     where id = _request;
  else
    _assignee := coalesce(_assignee, _r.preferred_employee_id);
    if _assignee is null then
      raise exception 'Choose who will do the work.' using errcode = '22023';
    end if;

    select department_id into _assignee_dept from public.employees
     where id = _assignee and status = 'Active';
    if _assignee_dept is distinct from _r.to_department_id then
      raise exception 'You can only assign this to somebody in your own department.' using errcode = '42501';
    end if;

    -- Theirs if they set one, otherwise what was asked for. Validated against the same list the
    -- task board uses, so a client cannot invent a priority the UI has no colour for.
    _final_priority := coalesce(nullif(btrim(coalesce(_priority,'')),''), _r.priority, 'Medium');
    if _final_priority not in ('Low','Medium','High','Urgent') then
      raise exception 'That is not a priority.' using errcode = '22023';
    end if;

    insert into public.tasks (employee_id, assigned_by, title, description, priority, due_date, status)
    values (_assignee, _r.requested_by, _r.title, _r.description, _final_priority, _r.due_date, 'To Do')
    returning id into _task;

    -- Keep the request showing what was actually agreed, so the requester sees the priority the
    -- work is really carrying rather than the one they asked for.
    update public.help_requests
       set status = 'Accepted', decided_by = _me, decided_at = now(),
           decision_note = nullif(btrim(coalesce(_note,'')),''),
           assigned_employee_id = _assignee, task_id = _task, priority = _final_priority
     where id = _request;
  end if;

  select e.user_id into _requester_user from public.employees e where e.id = _r.requested_by;
  perform app.notify_user(_requester_user, 'help',
    case when _accept then 'Your request was accepted' else 'Your request was declined' end,
    '"' || _r.title || '" — '
      || case when _accept
              then coalesce((select full_name from public.employees where id = _assignee), 'somebody') || ' is on it'
                   || case when _final_priority is distinct from _r.priority
                           then ' (' || lower(_final_priority) || ' priority)' else '' end || '.'
              else 'declined by ' || coalesce((select name from public.departments where id = _r.to_department_id), 'the other department') || '.'
         end
      || case when nullif(btrim(coalesce(_note,'')),'') is not null then ' Note: ' || btrim(_note) else '' end,
    'tasks/requests', _request);

  return _task;
end $$;

create or replace function public.cancel_help_request(_request uuid)
returns void language plpgsql security definer set search_path = public, app, pg_temp as $$
declare _r record;
begin
  if not app.session_is_active() then
    raise exception 'Account access is disabled.' using errcode='42501';
  end if;
  select * into _r from public.help_requests where id = _request;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = '42704';
  end if;
  if _r.status <> 'Pending' then
    raise exception 'Only a request still waiting for an answer can be withdrawn.' using errcode = '22023';
  end if;
  if not app.has_perm('task.request', _r.entity_id, null, _r.from_branch_id, _r.from_department_id, null) then
    raise exception 'That is not your request to withdraw.' using errcode = '42501';
  end if;
  update public.help_requests set status = 'Cancelled' where id = _request;
end $$;

-- Internal owner-only helpers must not remain callable by an authenticated database role.
-- Triggers and authorized definer RPCs still run as owner and retain their access.
revoke all on function app.actor_name(uuid),app.derive_login_email(uuid),app.derive_login_password(uuid),
  app.ensure_employee_self_role(uuid,uuid),
  app.notify_perm_holders(text,uuid,uuid,uuid,uuid,text,text,text,text,uuid)
  from public,anon,authenticated;


-- Restrictive policies combine with (never replace) every table's existing scope policy.
-- They also cover policies comparing auth.uid() directly: profiles, notifications, preferences,
-- device commands and personal storage objects. Existing invoker views inherit the same guard.
-- This migration deliberately does not enable RLS on previously unprotected service tables.
-- Storage policies belonging to this application target storage.objects only. Other storage
-- tables (including its migration tracker) are platform metadata with separate ownership;
-- attempting to alter them can abort the entire migration on a hosted database. Do not skip
-- application tables based on ownership: a missing app-table privilege must still fail closed.
do $$ declare _table record; begin
  for _table in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' or (n.nspname='storage' and c.relname='objects'))
      and c.relkind in ('r','p') and c.relrowsecurity
  loop
    execute format('drop policy if exists active_account_required on %I.%I',_table.nspname,_table.relname);
    execute format('create policy active_account_required on %I.%I as restrictive for all to authenticated using ((select app.session_is_active())) with check ((select app.session_is_active()))',_table.nspname,_table.relname);
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
