// Shared password requirements for voluntary, recovery and temporary-password changes.
// Names, usernames and email addresses are allowed; validation does not inspect identity.

export const MIN_LENGTH = 8;

/** The checklist shown under the field, in the order it is displayed. */
export const RULES = [
  {
    id: 'length',
    label: `At least ${MIN_LENGTH} characters`,
    ok: (pw) => (pw ?? '').length >= MIN_LENGTH,
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
export function passwordProblem(password) {
  if (!password) return RULES[0];
  return RULES.find((rule) => !rule.ok(password)) ?? null;
}
