-- Store both parent names with the employee's personal details.

begin;

alter table public.employees
  add column if not exists mother_name text;

comment on column public.employees.mother_name is
  'Employee mother or guardian name, recorded with personal details.';

commit;
