// My pay on a phone (round 2, after the reference phone kit): the latest take-home pay on the
// orange card, what this financial year has earned and deducted, then recent payslips. Tapping a
// payslip opens it in the month view below. There is no PDF download or paid date yet (the paid
// date sits in a table employees cannot read).
import React from 'react';
import { ChevronRight, ReceiptText, TrendingUp, Wallet, MinusCircle } from 'lucide-react';
import { usePayslips } from '../../data/payroll';
import { todayIso } from '../../data/attendance';
import { payYearTotals, periodLabel } from '../../lib/payYear';
import { StatCard, StatRow } from '../ui/StatCard';
import StatusPill from '../ui/StatusPill';
import { Skeleton } from '../ui/Skeleton';
import './myPayOverview.css';

const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n || 0));

export default function MyPayOverview({ employeeId, onOpen }) {
  const { data: payslips = [], isLoading } = usePayslips(employeeId, { enabled: Boolean(employeeId) });
  const latest = payslips[0];
  const year = payYearTotals(payslips, todayIso());
  return (
    <section className="my-pay-phone" aria-label="My pay">
      <button type="button" className="my-pay-card" disabled={!latest} onClick={() => latest && onOpen(latest.period, latest.id)}>
        <span className="my-pay-card-copy">
          <span>{latest ? `Take-home · ${periodLabel(latest.period)}` : 'Take-home pay'}</span>
          {isLoading ? <Skeleton className="h-8 w-36 bg-white/30" /> : <strong>{latest ? inr(latest.net) : '—'}</strong>}
          <small>{latest ? `${latest.status}${latest.paid_days ? ` · ${latest.paid_days} paid days` : ''}` : 'No payslip published yet'}</small>
        </span>
        <span className="my-pay-card-icon" aria-hidden="true"><Wallet size={22} /></span>
      </button>

      <StatRow label="This financial year">
        <StatCard label="Earned this year" value={inr(year.gross)} sub={`FY ${year.label}`} icon={TrendingUp} tone="green" loading={isLoading} />
        <StatCard label="Deductions" value={inr(year.deductions)} sub={`FY ${year.label}`} icon={MinusCircle} tone="red" loading={isLoading} />
      </StatRow>

      {payslips.length > 0 && (
        <div className="my-pay-list">
          <h3>Recent payslips</h3>
          {payslips.slice(0, 4).map((p) => (
            <button key={p.id} type="button" className="my-pay-row" onClick={() => onOpen(p.period, p.id)}>
              <span className="my-pay-row-icon" aria-hidden="true"><ReceiptText size={17} /></span>
              <span className="my-pay-row-copy"><strong>{periodLabel(p.period)}</strong><span>{inr(p.net)}</span></span>
              <StatusPill status={p.status} tone={p.status === 'Paid' || p.status === 'Published' ? 'success' : 'warning'} />
              <ChevronRight size={17} className="my-pay-row-chevron" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
