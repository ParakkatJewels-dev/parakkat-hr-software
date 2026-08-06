// "Just my own records", for screens that serve an employee and their manager from one list.
//
// Leave, Expenses and Payslips all show whatever RLS allows, which for a manager is their whole
// branch with their own rows somewhere in it. That is right for reviewing and useless for the
// question every one of those people also has — what did I claim, when am I off, what was I paid.
// Migration 0080 gave every manager role leave.create, expense.create and payslip.read precisely
// because they are employees too; this is the other half of that, on the screen.
//
// The initial value comes from the URL (`?mine=1`) so the My Workspace links can open a screen
// already narrowed, while the same screen reached from the oversight nav opens on everyone. After
// that it is ordinary state: the toggle is visible and one click either way.
import { useState } from 'react';
import { useLocation } from 'react-router-dom';

export function useMineOnly() {
  const { search } = useLocation();
  // Read once, on mount. Reading it every render would fight the toggle: flipping to "Everyone"
  // leaves ?mine=1 in the address bar and the next render would snap it straight back.
  const [mineOnly, setMineOnly] = useState(() => new URLSearchParams(search).get('mine') === '1');
  return [mineOnly, setMineOnly];
}

export default useMineOnly;
