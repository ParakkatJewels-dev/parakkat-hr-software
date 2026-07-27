-- 0042_payroll_earning_breakdown.sql
-- Fixes how earnings are presented and totalled.
--
-- 0041 emitted the whole monthly gross as one "GROSS" earning line and then ADDED any earning
-- component on top — so configuring "HRA = 40% of basic" turned an 18,000 salary into 19,458.
-- Earnings must break the agreed gross DOWN, the way a real payslip reads:
--
--     Basic                     7,225.81
--     HRA (40% of basic)        2,890.32
--     Other allowances          6,141.94   <- balancing figure
--     ------------------------------------
--     Gross earnings           16,258.07   = gross x paid_days / days_in_month
--
-- Deductions are unchanged. If the configured earning components exceed the gross (a
-- misconfiguration), the balancing line is clamped at zero and the payslip totals the lines it
-- actually shows, so what staff see always adds up.
-- Idempotent: safe to re-run.

create or replace function public.run_payroll(_entity_id uuid, _period text)
returns jsonb
language plpgsql security definer set search_path = app, public as $$
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

    select coalesce(sum(case when a.is_lop then 1 - coalesce(a.day_fraction, 0) else 0 end), 0)
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
                when 'fixed' then coalesce(_comp.amount, 0)
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
end $$;

grant execute on function public.run_payroll(uuid, text) to authenticated;
