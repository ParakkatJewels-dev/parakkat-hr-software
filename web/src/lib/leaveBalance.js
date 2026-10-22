// What a leave balance card shows (round 2, after the reference phone kit): days used out of the
// year's total, how far along the bar is, and how many are left. Total is the entitlement plus
// anything carried forward; "left" is the balance the database keeps, not total minus used,
// because pending requests and adjustments already count against it there.

export function balanceBar(balance) {
  const total = Number(balance?.entitled || 0) + Number(balance?.carried_forward || 0);
  const used = Number(balance?.used || 0);
  const left = Number(balance?.available ?? Math.max(0, total - used));
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
  return { total, used, left, percent };
}
