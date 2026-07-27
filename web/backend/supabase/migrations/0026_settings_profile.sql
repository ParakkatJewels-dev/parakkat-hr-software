-- 0026_settings_profile.sql
-- Make the Settings screen real (it was hardcoded mock UI):
--   1. org_settings — a tiny key/value store for workspace-level settings (company name, domain,
--      locale). Readable by everyone signed in; writable by super admins only.
--   2. update_my_profile(_phone) — lets any linked login edit the self-service fields of their
--      OWN employee row. A whitelisted RPC instead of employee.update-at-self, because the RLS
--      update policy is row-level: granting it would let people edit their own salary/branch.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1: workspace settings
-- ---------------------------------------------------------------------------
create table if not exists public.org_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

drop trigger if exists trg_org_settings_touch on public.org_settings;
create trigger trg_org_settings_touch
  before update on public.org_settings for each row execute function app.tg_set_updated_at();

alter table public.org_settings enable row level security;

drop policy if exists org_settings_select on public.org_settings;
create policy org_settings_select on public.org_settings for select to authenticated using (true);

drop policy if exists org_settings_write on public.org_settings;
create policy org_settings_write on public.org_settings for all to authenticated
  using (app.is_super_admin())
  with check (app.is_super_admin());

grant select, insert, update on public.org_settings to authenticated;

insert into public.org_settings (key, value) values
  ('workspace', '{"company_name": "Parakkat", "domain": "parakkatjewels.com", "locale": "en-IN (India)"}')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2: self-service profile update
-- ---------------------------------------------------------------------------
create or replace function public.update_my_profile(_phone text)
returns void language plpgsql security definer set search_path = app, public as $$
declare _emp uuid;
begin
  _emp := app.current_employee_id();
  if _emp is null then
    raise exception 'no employee record is linked to this login';
  end if;
  update public.employees
  set phone = nullif(trim(_phone), '')
  where id = _emp;
end $$;

grant execute on function public.update_my_profile(text) to authenticated;
