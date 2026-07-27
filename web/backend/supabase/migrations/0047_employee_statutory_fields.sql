-- 0047 — Statutory identity and bank details on employees.
--
-- Without these the system cannot pay anybody or file anything:
--   no bank account + IFSC  -> salaries cannot be transferred at all
--   no PAN                  -> no TDS, no Form 16, no Form 24Q
--   no UAN / PF number      -> no EPF ECR filing
--   no ESI number           -> no ESI return
--   no date of birth        -> gratuity eligibility and retirement cannot be computed
--   no gender               -> statutory registers and Maternity Benefit reporting
--
-- Everything is nullable. 242 people are already imported from spreadsheets that carried none of
-- this, so a NOT NULL here would either fail the migration or force junk values in. Completeness
-- is reported in the UI instead, which is honest about what is still missing per person.
--
-- Format checks are applied where the format is genuinely fixed and a typo is silent and costly —
-- a wrong IFSC sends a salary to the wrong bank. They allow NULL and only bite on a bad value.

begin;

alter table public.employees
  -- ---- identity ----------------------------------------------------------------------------
  add column if not exists date_of_birth   date,
  add column if not exists gender          text,
  add column if not exists father_name     text,
  add column if not exists personal_email  text,
  add column if not exists address         text,
  add column if not exists blood_group     text,

  -- ---- statutory ---------------------------------------------------------------------------
  add column if not exists pan             text,
  add column if not exists aadhaar         text,
  add column if not exists uan             text,   -- EPF Universal Account Number
  add column if not exists pf_number       text,
  add column if not exists esi_number      text,

  -- ---- how they get paid -------------------------------------------------------------------
  add column if not exists bank_name       text,
  add column if not exists bank_account    text,
  add column if not exists bank_ifsc       text,
  add column if not exists account_holder  text,  -- when it differs from full_name

  -- ---- who to call -------------------------------------------------------------------------
  add column if not exists emergency_name  text,
  add column if not exists emergency_phone text,
  add column if not exists emergency_relation text;

comment on column public.employees.aadhaar is
  'Sensitive. Reachable only through the employees RLS policies (scope-limited, or the person''s '
  'own record). Needed to link a UAN; do not expose it in list views or exports.';
comment on column public.employees.uan is
  'EPF Universal Account Number — 12 digits, follows the employee between employers.';

-- ---------------------------------------------------------------- format guards
-- Uppercase-normalised on write so comparisons and filings are consistent.
create or replace function app.tg_employee_normalise()
returns trigger language plpgsql as $$
begin
  new.pan        := nullif(upper(regexp_replace(coalesce(new.pan, ''),        '\s', '', 'g')), '');
  new.bank_ifsc  := nullif(upper(regexp_replace(coalesce(new.bank_ifsc, ''),  '\s', '', 'g')), '');
  new.aadhaar    := nullif(regexp_replace(coalesce(new.aadhaar, ''),          '\D', '', 'g'), '');
  new.uan        := nullif(regexp_replace(coalesce(new.uan, ''),              '\D', '', 'g'), '');
  new.bank_account := nullif(regexp_replace(coalesce(new.bank_account, ''),   '\s', '', 'g'), '');
  return new;
end $$;

drop trigger if exists tg_employee_normalise on public.employees;
create trigger tg_employee_normalise
  before insert or update on public.employees
  for each row execute function app.tg_employee_normalise();

-- PAN: five letters, four digits, one letter. The fourth letter encodes holder type ('P' for an
-- individual) but that is not enforced here — a firm's PAN can legitimately appear.
alter table public.employees drop constraint if exists employees_pan_format;
alter table public.employees add constraint employees_pan_format
  check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

-- IFSC: four-letter bank code, a reserved '0', then six alphanumerics.
alter table public.employees drop constraint if exists employees_ifsc_format;
alter table public.employees add constraint employees_ifsc_format
  check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

alter table public.employees drop constraint if exists employees_aadhaar_format;
alter table public.employees add constraint employees_aadhaar_format
  check (aadhaar is null or aadhaar ~ '^[0-9]{12}$');

alter table public.employees drop constraint if exists employees_uan_format;
alter table public.employees add constraint employees_uan_format
  check (uan is null or uan ~ '^[0-9]{12}$');

alter table public.employees drop constraint if exists employees_gender_values;
alter table public.employees add constraint employees_gender_values
  check (gender is null or gender in ('Male', 'Female', 'Other'));

-- A date of birth in the future, or implying an age outside 14–100, is a typo rather than a fact.
alter table public.employees drop constraint if exists employees_dob_sane;
alter table public.employees add constraint employees_dob_sane
  check (date_of_birth is null
         or (date_of_birth < current_date - interval '14 years'
             and date_of_birth > current_date - interval '100 years'));

-- ---------------------------------------------------------------- payroll readiness
-- What HR needs to chase, per person. A view rather than a column so it can never drift from the
-- data it describes.
create or replace view public.employee_payroll_readiness as
select
  e.id,
  e.entity_id,
  e.branch_id,
  e.employee_code,
  e.full_name,
  (e.bank_account is not null and e.bank_ifsc is not null) as can_be_paid,
  (e.pan is not null)                                      as tds_ready,
  (e.uan is not null)                                      as pf_ready,
  (e.date_of_birth is not null)                            as gratuity_ready,
  array_remove(array[
    case when e.bank_account is null or e.bank_ifsc is null then 'bank account' end,
    case when e.pan     is null then 'PAN' end,
    case when e.uan     is null then 'UAN' end,
    case when e.date_of_birth is null then 'date of birth' end,
    case when e.gender  is null then 'gender' end
  ], null) as missing
from public.employees e;

comment on view public.employee_payroll_readiness is
  'Per-employee view of what still blocks payroll and statutory filing. Inherits the employees '
  'RLS policies, so each caller sees only their own scope.';

grant select on public.employee_payroll_readiness to authenticated;

commit;
