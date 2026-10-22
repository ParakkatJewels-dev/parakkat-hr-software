// Leave balances on a phone (round 2, after the reference phone kit): the main leave type as a
// wide card with its bar and days remaining, the others as smaller cards two to a row, then the
// orange Apply leave button.
import React from 'react';
import { CalendarDays, Plus, ShieldPlus, Sun, Layers } from 'lucide-react';
import { balanceBar } from '../../lib/leaveBalance';
import './leaveBalanceCards.css';

const LOOKS = [
  { icon: Sun, tone: 'amber', bar: 'green' },
  { icon: ShieldPlus, tone: 'blue', bar: 'blue' },
  { icon: Layers, tone: 'violet', bar: 'violet' },
  { icon: CalendarDays, tone: 'green', bar: 'green' },
];

export default function LeaveBalanceCards({ balances, canApply, onApply }) {
  if (!balances.length && !canApply) return null;
  const [main, ...rest] = balances;
  const card = (balance, index, wide) => {
    const { total, used, left, percent } = balanceBar(balance);
    const { icon: Icon, tone, bar } = LOOKS[index % LOOKS.length];
    const name = balance.leave_type?.name || balance.leave_type?.code || 'Leave';
    return (
      <div key={balance.id ?? name} className={`leave-balance-card ${wide ? 'is-wide' : ''}`} data-tone={tone}>
        <span className="leave-balance-icon" aria-hidden="true"><Icon size={wide ? 20 : 17} /></span>
        <div className="leave-balance-copy">
          <span>{name}</span>
          <strong>{used} / {total}</strong>
        </div>
        <div className="leave-balance-bar" data-tone={bar} role="img" aria-label={`${used} of ${total} days used`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {wide && <small>{left} day{left === 1 ? '' : 's'} remaining</small>}
      </div>
    );
  };
  return (
    <section className="leave-balance-phone" aria-label="My leave balance">
      {main && card(main, 0, true)}
      {rest.length > 0 && <div className="leave-balance-grid">{rest.map((b, i) => card(b, i + 1, false))}</div>}
      {canApply && (
        <button type="button" className="leave-balance-apply" onClick={onApply}>
          <span aria-hidden="true"><Plus size={16} strokeWidth={2.6} /></span> Apply leave
        </button>
      )}
    </section>
  );
}
