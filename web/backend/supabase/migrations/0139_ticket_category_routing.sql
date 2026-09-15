-- Ticket categories belong to a receiving department. Requester ancestry stays separate from
-- the routing snapshot, so an employee asking HR for help never becomes an HR employee.
begin;

create table if not exists public.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  entity_id uuid not null references public.entities(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete restrict,
  zone_id uuid references public.zones(id) on delete set null,
  branch_id uuid references public.branches(id) on delete set null,
  is_active boolean not null default true,
  -- An explicit admin choice, used only to filter the HR queue; it never grants access.
  is_hr_queue boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index if not exists ticket_categories_entity_name_idx on public.ticket_categories(entity_id, lower(btrim(name)));
alter table public.ticket_categories enable row level security;
revoke all on public.ticket_categories from public, anon, authenticated;
grant select on public.ticket_categories to authenticated;

alter table public.tickets
  add column if not exists category_id uuid references public.ticket_categories(id) on delete restrict,
  add column if not exists routed_department_id uuid references public.departments(id) on delete restrict,
  add column if not exists routed_entity_id uuid references public.entities(id) on delete restrict,
  add column if not exists routed_zone_id uuid references public.zones(id) on delete set null,
  add column if not exists routed_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists is_hr_queue boolean not null default false;
create index if not exists tickets_routed_department_idx on public.tickets(routed_department_id, status, created_at desc, id);

create or replace function app.ticket_actor_active(_user uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select _user is not null
    and exists (select 1 from auth.users u where u.id = _user and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now()))
    and not exists (select 1 from public.profiles p join public.employees e on e.id = p.employee_id
      where p.user_id = _user and e.status <> 'Active');
$$;

-- The user argument is internal: notifications need to check their recipients using exactly
-- the same rules as the recipient's later read. These helpers are not directly executable.
create or replace function app.ticket_has_grant(_user uuid, _permission text,
  _entity uuid, _zone uuid, _branch uuid, _department uuid, _employee uuid default null)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.ticket_actor_active(_user) and (
    exists (select 1 from public.profiles p where p.user_id = _user and p.is_super_admin)
    or exists (select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
      where ra.user_id = _user and r.key = 'super_admin' and ra.scope_type = 'global')
    or exists (select 1 from public.role_assignments ra
      join public.role_permissions rp on rp.role_id = ra.role_id
      join public.permissions p on p.id = rp.permission_id and p.key = _permission
      where ra.user_id = _user and (
        ra.scope_type = 'global'
        or (ra.scope_type = 'entity' and ra.scope_id = _entity)
        or (ra.scope_type = 'zone' and ra.scope_id = _zone)
        or (ra.scope_type = 'branch' and ra.scope_id = _branch)
        or (ra.scope_type = 'department' and ra.scope_id = _department)
        or (ra.scope_type = 'self' and _employee is not null and exists (
          select 1 from public.profiles pr where pr.user_id = _user and pr.employee_id = _employee))
      )));
$$;

create or replace function app.ticket_has_role(_user uuid, _roles text[],
  _entity uuid, _zone uuid, _branch uuid, _department uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.ticket_actor_active(_user) and exists (
    select 1 from public.role_assignments ra join public.roles r on r.id = ra.role_id
    where ra.user_id = _user and r.key = any(_roles) and (
      ra.scope_type = 'global'
      or (ra.scope_type = 'entity' and ra.scope_id = _entity)
      or (ra.scope_type = 'zone' and ra.scope_id = _zone)
      or (ra.scope_type = 'branch' and ra.scope_id = _branch)
      or (ra.scope_type = 'department' and ra.scope_id = _department)));
$$;

create or replace function app.ticket_category_admin(_user uuid, _department uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select exists (select 1 from public.departments d left join public.branches b on b.id = d.branch_id
    -- HR's rbac.manage is for staff access provisioning, not organization configuration.
    where d.id = _department
      and app.ticket_has_grant(_user,'org.manage',d.entity_id,b.zone_id,d.branch_id,d.id,null));
$$;

create or replace function app.ticket_category_visible(_user uuid, _category public.ticket_categories)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.ticket_category_admin(_user,_category.department_id)
    or (_category.is_active and app.ticket_actor_active(_user) and (
      exists (select 1 from public.profiles p join public.employees e on e.id = p.employee_id
        where p.user_id = _user and e.entity_id = _category.entity_id and e.status = 'Active'
          and app.ticket_has_grant(_user,'ticket.create',e.entity_id,e.zone_id,e.branch_id,e.department_id,e.id))
      or app.ticket_has_grant(_user,'ticket.read',_category.entity_id,_category.zone_id,
        _category.branch_id,_category.department_id,null)));
$$;

create or replace function app.ticket_receiving_employee(_user uuid, _ticket public.tickets)
returns uuid language sql stable security definer set search_path = pg_catalog, public, app as $$
  select e.id from public.profiles p join public.employees e on e.id = p.employee_id
    where p.user_id = _user and e.status = 'Active' and e.department_id = _ticket.routed_department_id
      and e.entity_id = _ticket.routed_entity_id;
$$;

create or replace function app.ticket_manage_for(_user uuid, _ticket public.tickets)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.ticket_actor_active(_user) and case when _ticket.routed_department_id is null then
    -- Historic free-text tickets retain their original ownership and permission scope.
    app.ticket_has_grant(_user,'ticket.manage',_ticket.entity_id,_ticket.zone_id,
      _ticket.branch_id,_ticket.department_id,_ticket.employee_id)
  else
    app.ticket_has_grant(_user,'ticket.manage',_ticket.routed_entity_id,_ticket.routed_zone_id,
      _ticket.routed_branch_id,_ticket.routed_department_id,app.ticket_receiving_employee(_user,_ticket))
    or (app.ticket_has_role(_user,array['dept_head'],_ticket.routed_entity_id,_ticket.routed_zone_id,
          _ticket.routed_branch_id,_ticket.routed_department_id)
      and app.ticket_has_grant(_user,'ticket.read',_ticket.routed_entity_id,_ticket.routed_zone_id,
          _ticket.routed_branch_id,_ticket.routed_department_id,null))
    or (app.ticket_has_role(_user,array['hr_manager'],_ticket.entity_id,_ticket.zone_id,_ticket.branch_id,_ticket.department_id)
      and app.ticket_has_grant(_user,'ticket.manage',_ticket.entity_id,_ticket.zone_id,
        _ticket.branch_id,_ticket.department_id,_ticket.employee_id))
  end;
$$;

create or replace function app.ticket_read_for(_user uuid, _ticket public.tickets)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select app.ticket_actor_active(_user) and (
    (exists (select 1 from public.profiles p where p.user_id = _user and p.employee_id = _ticket.employee_id)
      and app.ticket_has_grant(_user,'ticket.read',_ticket.entity_id,_ticket.zone_id,_ticket.branch_id,_ticket.department_id,_ticket.employee_id))
    or app.ticket_manage_for(_user,_ticket)
    or case when _ticket.routed_department_id is null then
      app.ticket_has_grant(_user,'ticket.read',_ticket.entity_id,_ticket.zone_id,
        _ticket.branch_id,_ticket.department_id,_ticket.employee_id)
    else
      app.ticket_has_grant(_user,'ticket.read',_ticket.routed_entity_id,_ticket.routed_zone_id,
        _ticket.routed_branch_id,_ticket.routed_department_id,app.ticket_receiving_employee(_user,_ticket))
      or (app.ticket_has_role(_user,array['hr_manager'],_ticket.entity_id,_ticket.zone_id,_ticket.branch_id,_ticket.department_id)
        and app.ticket_has_grant(_user,'ticket.read',_ticket.entity_id,_ticket.zone_id,
          _ticket.branch_id,_ticket.department_id,_ticket.employee_id))
    end);
$$;

-- RLS wrappers resolve the stored row. A fabricated composite cannot manufacture capabilities.
create or replace function app.can_read_ticket(_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select app.ticket_read_for(auth.uid(),t) from public.tickets t where t.id=_id),false);
$$;
create or replace function app.can_manage_ticket(_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select app.ticket_manage_for(auth.uid(),t) from public.tickets t where t.id=_id),false);
$$;
create or replace function app.can_read_ticket_category(_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, app as $$
  select coalesce((select app.ticket_category_visible(auth.uid(),c) from public.ticket_categories c where c.id=_id),false);
$$;
drop policy if exists ticket_categories_read on public.ticket_categories;
create policy ticket_categories_read on public.ticket_categories for select to authenticated using (app.can_read_ticket_category(id));
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets for select to authenticated using (app.can_read_ticket(id));
drop policy if exists tickets_update on public.tickets;
create policy tickets_update on public.tickets for update to authenticated using (app.can_manage_ticket(id)) with check (app.can_manage_ticket(id));

create or replace function app.tg_ticket_route()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _category public.ticket_categories; _department public.departments;
begin
  if auth.uid() is not null and new.status not in ('Open','In Progress','On Hold','Resolved') then
    raise exception 'Choose an available ticket status.' using errcode='22023';
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.status <> 'Open' then
      raise exception 'New tickets must start Open.' using errcode='42501';
    end if;
    if new.category_id is not null then
      select * into _category from public.ticket_categories where id=new.category_id for share;
      select * into _department from public.departments where id=_category.department_id for share;
      if _category.id is null or not _category.is_active or _department.id is null or not _department.is_active
          or _category.entity_id is distinct from new.entity_id or _department.entity_id is distinct from new.entity_id then
        raise exception 'Choose an active ticket category in your company.' using errcode='22023';
      end if;
      new.category := _category.name;
      new.routed_department_id := _category.department_id;
      new.routed_entity_id := _department.entity_id;
      new.routed_branch_id := _department.branch_id;
      select zone_id into new.routed_zone_id from public.branches where id=_department.branch_id;
      new.is_hr_queue := _category.is_hr_queue;
    else
      -- Old clients can still submit a historic category until rollout finishes. They cannot
      -- forge a receiving department or turn that legacy ticket into an HR queue item.
      new.routed_department_id := null; new.routed_entity_id := null;
      new.routed_zone_id := null; new.routed_branch_id := null; new.is_hr_queue := false;
    end if;
  elsif (new.employee_id,new.category_id,new.category,new.routed_department_id,new.routed_entity_id,
      new.routed_zone_id,new.routed_branch_id,new.is_hr_queue) is distinct from
      (old.employee_id,old.category_id,old.category,old.routed_department_id,old.routed_entity_id,
      old.routed_zone_id,old.routed_branch_id,old.is_hr_queue) then
    raise exception 'A ticket retains its original requester, category and receiving department.' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_tickets_route on public.tickets;
create trigger trg_tickets_route before insert or update on public.tickets for each row execute function app.tg_ticket_route();
-- Direct updates remain compatible with old clients but cannot rewrite routing or ownership.
revoke insert, update on public.tickets from authenticated;
grant insert (id,employee_id,category,category_id,subject,description,priority) on public.tickets to authenticated;
grant update (status) on public.tickets to authenticated;

create or replace function public.get_ticket_access()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
declare _user uuid:=auth.uid(); _department uuid; _hr boolean;
begin
  if not app.ticket_actor_active(_user) then raise exception 'Sign in with an active account.' using errcode='42501'; end if;
  select e.department_id into _department from public.profiles p join public.employees e on e.id=p.employee_id where p.user_id=_user;
  select exists(select 1 from public.role_assignments ra join public.roles r on r.id=ra.role_id
    join public.role_permissions rp on rp.role_id=r.id join public.permissions p on p.id=rp.permission_id
    where ra.user_id=_user and r.key='hr_manager' and p.key='ticket.read') into _hr;
  return jsonb_build_object(
    'can_manage_categories',exists(select 1 from public.departments d where app.ticket_category_admin(_user,d.id)),
    'is_hr',_hr,'department_id',_department,
    'can_view_queue',exists(select 1 from public.departments d left join public.branches b on b.id=d.branch_id
      where app.ticket_has_grant(_user,'ticket.read',d.entity_id,b.zone_id,d.branch_id,d.id,
        case when d.id=_department then app.current_employee_id() else null end)),
    'hr_department_ids',coalesce((select jsonb_agg(distinct c.department_id) from public.ticket_categories c
      where c.is_hr_queue and app.ticket_category_visible(_user,c)),'[]'::jsonb));
end $$;

create or replace function public.list_ticket_categories()
returns table(id uuid,name text,entity_id uuid,department_id uuid,department jsonb,
  is_active boolean,is_hr_queue boolean,can_manage boolean)
language sql stable security definer set search_path = pg_catalog, public, app as $$
  select c.id,c.name,c.entity_id,c.department_id,
    jsonb_build_object('id',d.id,'name',d.name,'code',d.code,'entity_id',d.entity_id,'branch_id',d.branch_id,'is_active',d.is_active),
    c.is_active,c.is_hr_queue,app.ticket_category_admin(auth.uid(),c.department_id)
  from public.ticket_categories c join public.departments d on d.id=c.department_id
  where app.ticket_category_visible(auth.uid(),c) order by c.name,c.id;
$$;

create or replace function public.save_ticket_category(_name text,_department_id uuid,_id uuid default null,
  _is_active boolean default true,_is_hr_queue boolean default false)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _old public.ticket_categories; _department public.departments; _zone uuid; _saved uuid;
begin
  if not app.ticket_category_admin(auth.uid(),_department_id) then
    raise exception 'Only an administrator in this department scope can manage ticket categories.' using errcode='42501';
  end if;
  select * into _department from public.departments where id=_department_id for share;
  if (_is_active and not _department.is_active) or char_length(btrim(coalesce(_name,''))) not between 1 and 80
      or _is_active is null or _is_hr_queue is null then
    raise exception 'Use a category name of 1 to 80 characters and an active department.' using errcode='22023';
  end if;
  select b.zone_id into _zone from public.branches b where b.id=_department.branch_id;
  if _id is not null then
    select * into _old from public.ticket_categories where id=_id for update;
    if _old.id is null or not app.ticket_category_admin(auth.uid(),_old.department_id) then
      raise exception 'That category is outside the scope you administer.' using errcode='42501';
    end if;
    if _old.entity_id <> _department.entity_id then
      raise exception 'A category cannot move to another company.' using errcode='22023';
    end if;
    update public.ticket_categories set name=btrim(_name),department_id=_department_id,
      branch_id=_department.branch_id,zone_id=_zone,is_active=_is_active,is_hr_queue=_is_hr_queue,updated_at=clock_timestamp()
      where ticket_categories.id=_id returning ticket_categories.id into _saved;
  else
    insert into public.ticket_categories(name,entity_id,department_id,branch_id,zone_id,is_active,is_hr_queue)
      values(btrim(_name),_department.entity_id,_department_id,_department.branch_id,_zone,_is_active,_is_hr_queue)
      returning ticket_categories.id into _saved;
  end if;
  return _saved;
end $$;

create or replace function public.create_ticket(_category_id uuid,_subject text,_priority text default 'Medium',_description text default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _employee public.employees; _id uuid;
begin
  select e.* into _employee from public.profiles p join public.employees e on e.id=p.employee_id where p.user_id=auth.uid();
  if _employee.id is null or not app.ticket_has_grant(auth.uid(),'ticket.create',_employee.entity_id,
      _employee.zone_id,_employee.branch_id,_employee.department_id,_employee.id) then
    raise exception 'Only an active employee with ticket access can raise a request.' using errcode='42501';
  end if;
  if _category_id is null or char_length(btrim(coalesce(_subject,''))) not between 1 and 500
      or _priority is null or _priority not in ('Low','Medium','High') or char_length(coalesce(_description,''))>10000 then
    raise exception 'Choose a category, enter a subject and select Low, Medium or High priority.' using errcode='22023';
  end if;
  insert into public.tickets(employee_id,category_id,subject,priority,description)
    values(_employee.id,_category_id,btrim(_subject),_priority,nullif(btrim(_description),'')) returning id into _id;
  return _id;
end $$;

create or replace function public.list_tickets(_since date default current_date-180)
returns table(id uuid,category text,subject text,description text,priority text,status text,created_at timestamptz,
  entity_id uuid,zone_id uuid,branch_id uuid,department_id uuid,employee_id uuid,employee jsonb,
  category_id uuid,routed_department_id uuid,routed_department jsonb,category_detail jsonb,is_hr_queue boolean,can_manage boolean)
language sql stable security definer set search_path = pg_catalog, public, app as $$
  select t.id,t.category,t.subject,t.description,t.priority,t.status,t.created_at,
    t.entity_id,t.zone_id,t.branch_id,t.department_id,t.employee_id,
    jsonb_build_object('id',e.id,'full_name',e.full_name,'employee_code',e.employee_code,'branch',jsonb_build_object('code',b.code)),
    t.category_id,t.routed_department_id,
    case when d.id is not null then jsonb_build_object('id',d.id,'name',d.name,'code',d.code) end,
    case when t.category_id is not null then jsonb_build_object('id',t.category_id,'name',t.category,'is_hr_queue',t.is_hr_queue) end,
    t.is_hr_queue,app.ticket_manage_for(auth.uid(),t)
  from public.tickets t join public.employees e on e.id=t.employee_id
  left join public.branches b on b.id=t.branch_id left join public.departments d on d.id=t.routed_department_id
  where app.ticket_read_for(auth.uid(),t)
    and (t.status in ('Open','In Progress','On Hold') or t.created_at>=coalesce(_since,current_date-180))
  order by t.created_at desc,t.id;
$$;

create or replace function public.set_ticket_status(_id uuid,_status text)
returns void language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _ticket public.tickets;
begin
  select * into _ticket from public.tickets where id=_id for update;
  if _ticket.id is null or not app.ticket_manage_for(auth.uid(),_ticket) then
    raise exception 'Only the receiving team or an authorized HR/admin handler can update this ticket.' using errcode='42501';
  end if;
  if _status is null or _status not in ('Open','In Progress','On Hold','Resolved') then
    raise exception 'Choose an available ticket status.' using errcode='22023';
  end if;
  update public.tickets set status=_status where tickets.id=_id;
end $$;

create or replace function app.tg_notify_ticket()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare _name text; _owner uuid; _recipient uuid;
begin
  select full_name,user_id into _name,_owner from public.employees where id=new.employee_id;
  if tg_op='INSERT' then
    -- Use the receiving scope, never the requester's department. HR oversight does not create
    -- duplicate alerts for every HR employee when the request belongs to another department.
    for _recipient in select p.user_id from public.profiles p where p.user_id is distinct from auth.uid()
      and app.ticket_read_for(p.user_id,new) and (
        (new.routed_department_id is null and app.ticket_manage_for(p.user_id,new))
        or (new.routed_department_id is not null and (
          app.ticket_receiving_employee(p.user_id,new) is not null
          or app.ticket_has_role(p.user_id,array['dept_head'],new.routed_entity_id,new.routed_zone_id,new.routed_branch_id,new.routed_department_id)
          or app.ticket_has_grant(p.user_id,'ticket.manage',new.routed_entity_id,new.routed_zone_id,new.routed_branch_id,new.routed_department_id,null))))
    loop
      perform app.notify_user(_recipient,'ticket','New helpdesk ticket',coalesce(_name,'An employee')||' raised: "'||new.subject||'".','helpdesk',new.id);
    end loop;
  elsif new.status is distinct from old.status then
    perform app.notify_user(_owner,'ticket','Ticket '||lower(new.status),'Your ticket "'||new.subject||'" is now '||new.status||'.','helpdesk',new.id);
  end if;
  if tg_op='UPDATE' and new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
    select user_id into _recipient from public.employees where id=new.assigned_to;
    if app.ticket_read_for(_recipient,new) then
      perform app.notify_user(_recipient,'ticket','Ticket assigned to you','"'||new.subject||'" ('||coalesce(new.priority,'Medium')||' priority).','helpdesk',new.id);
    end if;
  end if;
  return new;
end $$;

revoke all on function app.ticket_actor_active(uuid),app.ticket_has_grant(uuid,text,uuid,uuid,uuid,uuid,uuid),
  app.ticket_has_role(uuid,text[],uuid,uuid,uuid,uuid),app.ticket_category_admin(uuid,uuid),
  app.ticket_category_visible(uuid,public.ticket_categories),app.ticket_receiving_employee(uuid,public.tickets),
  app.ticket_manage_for(uuid,public.tickets),app.ticket_read_for(uuid,public.tickets),app.tg_ticket_route(),app.tg_notify_ticket()
  from public,anon,authenticated;
revoke all on function app.can_read_ticket(uuid),app.can_manage_ticket(uuid),app.can_read_ticket_category(uuid) from public,anon;
grant execute on function app.can_read_ticket(uuid),app.can_manage_ticket(uuid),app.can_read_ticket_category(uuid) to authenticated;
revoke all on function public.get_ticket_access(),public.list_ticket_categories(),
  public.save_ticket_category(text,uuid,uuid,boolean,boolean),public.create_ticket(uuid,text,text,text),
  public.list_tickets(date),public.set_ticket_status(uuid,text) from public,anon;
grant execute on function public.get_ticket_access(),public.list_ticket_categories(),
  public.save_ticket_category(text,uuid,uuid,boolean,boolean),public.create_ticket(uuid,text,text,text),
  public.list_tickets(date),public.set_ticket_status(uuid,text) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ticket_categories') then
    alter publication supabase_realtime add table public.ticket_categories;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
