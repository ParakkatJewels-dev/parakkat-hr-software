-- Enforce new writes without blocking upgrades because of legacy blank titles.
alter table public.jobs drop constraint if exists jobs_title_not_blank;
alter table public.jobs add constraint jobs_title_not_blank
  check (length(btrim(title, E' \t\n\r\f' || chr(11))) > 0) not valid;
