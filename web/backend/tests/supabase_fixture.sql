-- Minimal platform shell for a disposable PostgreSQL cluster. Application schema/functions/RLS
-- are loaded from every production migration; hosted Auth, Storage HTTP and Realtime are not run.
\set ON_ERROR_STOP on
create schema auth;
create schema storage;
create schema extensions;
do $$ begin
  if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
-- Supabase grants new public objects to API roles by default. Reproduce that so anonymous
-- negative tests exercise row policies and explicit revokes instead of an artificially absent ACL.
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table auth.users (
  id uuid primary key, instance_id uuid, aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, created_at timestamptz, updated_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  confirmation_token text, recovery_token text, email_change_token_new text, email_change text,
  last_sign_in_at timestamptz, phone text, banned_until timestamptz
);
create table auth.identities (
  id uuid primary key, provider_id text, user_id uuid references auth.users(id), identity_data jsonb,
  provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz
);
create table storage.buckets (
  id text primary key, name text, public boolean default false, file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now()
);
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;
alter table storage.objects enable row level security;
grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
grant execute on function auth.uid(), storage.foldername(text) to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
