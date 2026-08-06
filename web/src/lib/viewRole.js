// Which of your own roles you are looking at the app THROUGH.
//
// An HR manager is also an employee. They punch in, take leave, read their own payslip — migration
// 0080 granted every manager role exactly those permissions for that reason. But the navigation
// hands the self-service tree only to someone whose primary role IS employee, so a manager got the
// oversight layout and nowhere to be an employee in it.
//
// The first attempt bolted a "My Workspace" section onto the oversight tree. It worked and it read
// badly: two Attendances in one sidebar, one of them yours, distinguishable only by the label. This
// is the same idea turned the right way round — pick the role you are working as, and the whole
// app follows: the sidebar, the dashboard preset, the name in the corner.
//
// NOT A PRIVILEGE SWITCH. Nothing here changes what the database will hand over; RLS answers to the
// signed-in user and nothing else. Choosing "Employee" narrows what is put in front of you, not
// what you could reach by typing a URL — which is exactly why the route guard in App.jsx keeps
// checking real permissions rather than this.
//
// Same module-store shape as timeFormat.js: read at the point of use, subscribed via
// useSyncExternalStore, so switching repaints every screen at once instead of on the next
// unrelated render.
import { useSyncExternalStore } from 'react';

const KEY = 'view-role';

function read() {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    // Private browsing or a locked-down policy. The switch still works, it just does not remember.
    return null;
  }
}

let chosen = read();
const listeners = new Set();

export function getChosenRole() {
  return chosen;
}

/** Pass null to go back to following whatever your most senior role is. */
export function setChosenRole(next) {
  if (next === chosen) return;
  chosen = next ?? null;
  try {
    if (chosen) window.localStorage.setItem(KEY, chosen);
    else window.localStorage.removeItem(KEY);
  } catch {
    // Not remembering it is better than not applying it.
  }
  for (const l of listeners) l();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The role to present the app as, and a setter.
 *
 * `held` is the roles this person actually has, most senior first. A stored choice that is not in
 * that list is ignored rather than honoured — someone whose branch_manager role was revoked should
 * come back as whatever they are now, not as a manager view over data they can no longer read. It
 * would look like a broken screen rather than a removed permission.
 */
export function useViewRole(primaryRole, held) {
  const stored = useSyncExternalStore(subscribe, getChosenRole, () => null);
  const valid = stored && held.includes(stored) ? stored : primaryRole;
  return [valid, setChosenRole];
}
