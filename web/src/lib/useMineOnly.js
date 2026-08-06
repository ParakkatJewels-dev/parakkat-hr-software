// "Just my own records", for lists that serve an employee and their manager from one query.
//
// Leave, Expenses, Payslips, Documents and Tasks all show whatever RLS returns, which for a manager
// is their whole scope with their own rows somewhere in it. Correct for reviewing; useless for the
// question every one of those people also has — what did I claim, when am I off, what was I paid.
//
// DERIVED, NOT STORED. The first version kept this in state seeded from a `?mine=1` query
// parameter, which was wrong twice over: nothing in the app ever set that parameter after the links
// that used it were removed, and state seeded once cannot react to the view switcher — flipping to
// "Employee" in Settings left every list showing the whole branch under an ESS label. That is the
// bug this file now exists to prevent rather than cause.
//
// So: if you cannot see beyond yourself, the list is yours and there is nothing to toggle. That one
// rule covers both people it needs to — a genuine employee, whose grants are all self-scoped, and a
// manager working as an employee, whose grants usePermissions has narrowed to the same thing.
import { useState } from 'react';

/**
 * @param {boolean} canSeeOthers  Whether this viewer's grants reach beyond their own record for the
 *                                permission this list is built on — canBeyondSelf('leave.read') and
 *                                friends. Pass the value, not the function.
 * @returns {[boolean, (v: boolean) => void, boolean]}
 *          [mineOnly, setMineOnly, showToggle]. `showToggle` is false when there is no choice to
 *          offer, so screens do not draw a two-state control that can only ever be in one state.
 */
export function useMineOnly(canSeeOthers) {
  const [preferMine, setPreferMine] = useState(false);
  // Forced, not defaulted: someone who cannot see other people's rows must not be able to toggle
  // into a view that would show them nothing extra and imply the rows exist.
  const mineOnly = canSeeOthers ? preferMine : true;
  return [mineOnly, setPreferMine, canSeeOthers];
}

export default useMineOnly;
