-- Pay what the attendance says, not what a flag nobody sets says.
--
-- Two surgical changes to run_payroll, applied to the function as it actually exists rather than
-- retyped: an earlier attempt rewrote it from a partial read and got the return type wrong
-- (it returns jsonb, not uuid), which Postgres refused. Everything else below is byte-for-byte the
-- deployed definition.
--
-- NOTHING HAS BEEN PAID FROM THIS SYSTEM YET — payroll_runs, payslips, salary_structures and
-- pay_components are all empty — so this corrects the rule before its first use.
--
-- READ BEFORE THE FIRST RUN. Docking for absence is only right if the absences are real, and today
-- many are not: no holidays are configured (Onam reads 99% absent, Vishu 96%, Christmas 87%), 26
-- people who left months ago are still Active and still accruing absences, and three employees work
-- evenings against a 09:00-17:30 default. The rule is right; the data underneath it is not ready.
-- Fix the calendar and the leavers, run a draft month, and read it before publishing.

CREATE OR REPLACE FUNCTION public.run_payroll(_entity_id uuid, _period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'app', 'public'
AS $function$
declare
  _from        date;
  _to          date;
  _days        int;
  _run_id      uuid;
  _emp         record;
  _sal         record;
  _comp        record;
  _lop         numeric(6,2);
  _paid        numeric(6,2);
  _per_day     numeric(14,4);
  _gross_paid  numeric(12,2);
  _basic_paid  numeric(12,2);
  _earn        numeric(12,2);
  _named_earn  numeric(12,2);
  _other       numeric(12,2);
  _ded         numeric(12,2);
  _emp_cost    numeric(12,2);
  _base        numeric(12,2);
  _amt         numeric(12,2);
  _payslip_id  uuid;
  _count       int := 0;
  _sum_gross   numeric(14,2) := 0;
  _sum_net     numeric(14,2) := 0;
begin
  if _period !~ '^\d{4}-\d{2}$' then
    raise exception 'period must be YYYY-MM';
  end if;
  if auth.uid() is not null
     and not app.has_perm('payroll.manage', _entity_id, null, null, null, null) then
    raise exception 'not authorized to run payroll for this entity';
  end if;

  _from := (_period || '-01')::date;
  _to   := (_from + interval '1 month - 1 day')::date;
  _days := extract(day from _to)::int;

  if exists (select 1 from public.payroll_runs
              where entity_id = _entity_id and period = _period and status = 'Published') then
    raise exception 'payroll for % is already published — unpublish it first', _period;
  end if;

  insert into public.payroll_runs (entity_id, period, status, run_by)
  values (_entity_id, _period, 'Draft', auth.uid())
  on conflict (entity_id, period) do update set status = 'Draft', run_by = excluded.run_by
  returning id into _run_id;

  delete from public.payslips where run_id = _run_id;

  for _emp in
    select e.id, e.entity_id, e.zone_id, e.branch_id, e.department_id
      from public.employees e
     where e.entity_id = _entity_id and e.status = 'Active'
  loop
    select * into _sal
      from public.salary_structures s
     where s.employee_id = _emp.id and s.effective_from <= _to
     order by s.effective_from desc
     limit 1;
    continue when _sal.id is null;

    -- Unpaid days come from what each working day was worth, not from a reason code.
    --
    -- This read `case when a.is_lop then ...`, and attendance.is_lop has exactly one writer: an
    -- approved leave whose type is marked unpaid. Measured on the live database, 0 of 58,500 rows
    -- have ever had it set and `leaves` is empty — so this sum was always 0, _paid was always the
    -- whole month, and everybody would have been paid in full through 1,324 recorded July absences.
    --
    -- day_fraction already prices the day: 1 worked, 1 paid leave, 1 weekly off or holiday, 0.5 a
    -- half day, 0 an absence or unpaid leave. Restricted to day_type='working' because a rest day
    -- is paid — counting those would dock everyone for every Sunday.
    select coalesce(sum(case when a.day_type = 'working'
                             then greatest(0, 1 - coalesce(a.day_fraction, 0))
                             else 0 end), 0)
      into _lop
      from public.attendance a
     where a.employee_id = _emp.id and a.work_date between _from and _to;

    _paid       := greatest(_days - _lop, 0);
    _per_day    := _sal.gross / _days;
    _gross_paid := round(_per_day * _paid, 2);
    _basic_paid := round((_sal.basic / _days) * _paid, 2);

    _earn       := 0;
    _named_earn := 0;
    _ded        := 0;
    _emp_cost   := 0;

    insert into public.payslips (employee_id, period, gross, deductions, net, status,
                                 run_id, paid_days, lop_days, employer_cost,
                                 entity_id, zone_id, branch_id, department_id)
    values (_emp.id, _period, 0, 0, 0, 'Draft', _run_id, _paid, _lop, 0,
            _emp.entity_id, _emp.zone_id, _emp.branch_id, _emp.department_id)
    on conflict (employee_id, period) do update
      set run_id = excluded.run_id, paid_days = excluded.paid_days,
          lop_days = excluded.lop_days, status = 'Draft'
    returning id into _payslip_id;

    delete from public.payslip_lines where payslip_id = _payslip_id;

    -- 1. Basic is always the first earning line.
    insert into public.payslip_lines (payslip_id, code, name, kind, amount, sort_order)
    values (_payslip_id, 'BASIC', 'Basic', 'earning', _basic_paid, 1);
    _earn := _basic_paid;

    -- 2. Configured components. Earnings are carved OUT of gross, deductions reduce net.
    for _comp in select * from app.components_for(_emp.id) loop
      continue when _comp.min_gross is not null and _sal.gross < _comp.min_gross;
      continue when _comp.max_gross is not null and _sal.gross > _comp.max_gross;

      _base := case _comp.calc_type
                 when 'percent_of_basic' then case when _comp.prorate_on_lop then _basic_paid else _sal.basic end
                 when 'percent_of_gross' then case when _comp.prorate_on_lop then _gross_paid else _sal.gross end
                 else 0
               end;
      if _comp.cap_base is not null and _base > _comp.cap_base then
        _base := _comp.cap_base;
      end if;

      _amt := case _comp.calc_type
                -- A fixed amount prorates too when the component asks it to. prorate_on_lop was
                -- read only when building the percentage base, so 'fixed' ignored it entirely —
                -- while the form defaults that checkbox ON and captions it "Reduce with unpaid
                -- days" beside the Fixed option. A 1,600 allowance was paid whole to somebody who
                -- worked three days, and once the untouched fixed lines exceeded the prorated
                -- gross the balancing "other earnings" line went negative and was dropped, so the
                -- overage inflated the payslip while it still self-reconciled.
                when 'fixed' then
                  case when _comp.prorate_on_lop and _days > 0
                       then round(coalesce(_comp.amount, 0) * _paid / _days, 2)
                       else coalesce(_comp.amount, 0) end
                else round(_base * coalesce(_comp.rate, 0) / 100.0, 2)
              end;
      if _comp.max_amount is not null and _amt > _comp.max_amount then
        _amt := _comp.max_amount;
      end if;
      continue when _amt = 0;

      if _comp.employer_share then
        _emp_cost := _emp_cost + _amt;
        insert into public.payslip_lines (payslip_id, code, name, kind, amount, sort_order)
        values (_payslip_id, _comp.code, _comp.name, 'employer', _amt, 500 + _comp.display_order);
      elsif _comp.kind = 'earning' then
        _named_earn := _named_earn + _amt;
        _earn := _earn + _amt;
        insert into public.payslip_lines (payslip_id, code, name, kind, amount, sort_order)
        values (_payslip_id, _comp.code, _comp.name, 'earning', _amt, 10 + _comp.display_order);
      else
        _ded := _ded + _amt;
        insert into public.payslip_lines (payslip_id, code, name, kind, amount, sort_order)
        values (_payslip_id, _comp.code, _comp.name, 'deduction', _amt, 300 + _comp.display_order);
      end if;
    end loop;

    -- 3. Whatever of the agreed gross is not already named becomes "Other allowances".
    _other := round(_gross_paid - _basic_paid - _named_earn, 2);
    if _other > 0 then
      insert into public.payslip_lines (payslip_id, code, name, kind, amount, sort_order)
      values (_payslip_id, 'OTHER', 'Other allowances', 'earning', _other, 200);
      _earn := _earn + _other;
    end if;

    update public.payslips
       set gross = _earn, deductions = _ded, net = _earn - _ded, employer_cost = _emp_cost
     where id = _payslip_id;

    _count     := _count + 1;
    _sum_gross := _sum_gross + _earn;
    _sum_net   := _sum_net + (_earn - _ded);
  end loop;

  update public.payroll_runs
     set employees = _count, total_gross = _sum_gross, total_net = _sum_net
   where id = _run_id;

  return jsonb_build_object('run_id', _run_id, 'period', _period, 'employees', _count,
                            'total_gross', _sum_gross, 'total_net', _sum_net);
end $function$;

-- Recreating the function resets its ACL to the schema default, which grants EXECUTE to PUBLIC —
-- the grant 0074 removed after finding an anonymous caller could rewrite a period's payslips.
revoke execute on function public.run_payroll(_entity_id uuid, _period text) from public, anon;
grant  execute on function public.run_payroll(_entity_id uuid, _period text) to authenticated, service_role;
