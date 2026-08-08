-- 0094_leaves_speak_the_catalog_language.sql
--
-- Repair the leave rows the apply form mislabelled.
--
-- The engine joins leave_types.code = leaves.type — 0014 says so in its header — but the apply
-- form wrote its own hardcoded DISPLAY labels into leaves.type: 'Casual Leave' where the catalog
-- says CL, 'Comp Off' where it says CO. No request filed from that screen ever matched a leave
-- type, so type-level behaviour never applied: balances were not deducted, and a Loss of Pay
-- leave — explicitly unpaid in the catalog — was paid in full, because an unmatched type falls
-- through as plain paid leave.
--
-- The form is fixed to offer the catalog and write codes (Leave.jsx). This repairs history so
-- approved leave already on file starts meaning what it always said. Payroll runs that already
-- paid an unmatched LOP are NOT retroactively changed by this — a published payslip is a
-- statement of what was paid — but every future run over these dates now sees the truth.
--
-- The mapping targets the exact strings the old form could produce, nothing wider: a value typed
-- through any other path is somebody's deliberate data and not ours to reinterpret.

-- 'Paternity Leave' was offered by the form but never existed in the catalog, so it gets a row
-- before its leaves can point at it. Modelled on maternity: paid, no balance deduction. Quota is
-- deliberately 0 — HR sets policy in HR > Leave Types; this only makes the type exist.
insert into public.leave_types (code, name, annual_quota, is_paid, allow_half_day, carry_forward,
                                max_carry_forward, deducts_balance, colour, sort_order)
values ('PAT', 'Paternity Leave', 0, true, false, false, 0, false, '#06b6d4', 6)
on conflict (code) do nothing;

update public.leaves
   set type = case type
                when 'Casual Leave'       then 'CL'
                when 'Sick Leave'         then 'SL'
                when 'Earned Leave'       then 'EL'
                when 'Comp Off'           then 'CO'
                when 'Maternity Leave'    then 'MAT'
                when 'Paternity Leave'    then 'PAT'
                when 'Loss of Pay (LOP)'  then 'LOP'
              end
 where type in ('Casual Leave', 'Sick Leave', 'Earned Leave', 'Comp Off',
                'Maternity Leave', 'Paternity Leave', 'Loss of Pay (LOP)');

-- Attendance derives leave from these rows, so days covered by a repaired leave are stale until
-- recomputed. Queue exactly those days, not the world. DISTINCT because overlapping leaves name
-- the same day twice, and the conflict clause because idx_recompute_unique_pending (0013) already
-- collapses pending duplicates — without it one already-queued day would abort this whole repair.
insert into public.attendance_recompute_queue (employee_id, work_date, reason)
select distinct l.employee_id, d::date, 'leave type repaired (0094)'
  from public.leaves l,
       generate_series(l.start_date, l.end_date, interval '1 day') d
 where l.type in ('CL', 'SL', 'EL', 'CO', 'MAT', 'PAT', 'LOP')
   and l.status = 'Approved'
   and l.employee_id is not null
on conflict (employee_id, work_date) where processed_at is null do nothing;
