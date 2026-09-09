// What counts as a replacement for the provisioned password.
//
// The default is {name}{last four of their phone}. The whole point of the forced change is to get
// off a password colleagues can compute, so the rules below exist mainly to stop somebody typing
// something equivalent to it back in — "Ramesh4821" for "Ramesh Kumar" is not a new password, it
// is the same idea with different digits.
//
// Deliberately short of a full strength meter. These are factory-floor and shop-counter staff on
// shared devices; rules people cannot satisfy get written on a sticky note next to the terminal,
// which is worse than the password itself. Length, and not-your-own-name, catch the actual risk
// here without turning sign-in into a puzzle.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The name parts worth blocking — whole name and each word of it, plus the email's local part. */
function forbiddenParts({ name, email } = {}) {
  const parts = new Set();
  const whole = norm(name);
  if (whole.length >= 3) parts.add(whole);
  for (const word of String(name ?? '').split(/\s+/)) {
    const w = norm(word);
    if (w.length >= 3) parts.add(w);
  }
  const local = norm(String(email ?? '').split('@')[0]);
  if (local.length >= 3) parts.add(local);
  return [...parts];
}

/**
 * Does the password contain the person's own name (or email name)?
 *
 * Compared with punctuation and case stripped from both sides, so "Ramesh.Kumar-4821" is caught
 * exactly as "ramesh4821" is. This is the rule that actually does the work.
 */
export function containsOwnName(password, identity = {}) {
  const p = norm(password);
  if (!p) return false;
  return forbiddenParts(identity).some((part) => p.includes(part));
}

export const MIN_LENGTH = 8;

/** The checklist shown under the field, in the order it is displayed. */
export const RULES = [
  {
    id: 'length',
    label: `At least ${MIN_LENGTH} characters`,
    ok: (pw) => (pw ?? '').length >= MIN_LENGTH,
  },
  {
    id: 'not-name',
    label: 'Not your own name',
    ok: (pw, identity) => !containsOwnName(pw, identity),
  },
  {
    id: 'variety',
    // A run of digits is what a phone number is, and what people reach for when told "8 characters".
    label: 'Not only numbers',
    ok: (pw) => !/^\d*$/.test(pw ?? ''),
  },
];

/**
 * The first unmet rule, or null when the password is acceptable.
 * Returns the rule so the caller can name it; the checklist shows all of them anyway.
 */
export function passwordProblem(password, identity = {}) {
  if (!password) return RULES[0];
  return RULES.find((rule) => !rule.ok(password, identity)) ?? null;
}
