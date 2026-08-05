// The format guards from migration 0047, restated on the client.
//
// Postgres already refuses a PAN that cannot be real — that refusal is the 400 you get back from a
// save. Catching it here is not about trusting the client; the database stays the authority. It is
// about telling someone their PAN is wrong while they are still looking at the PAN field, instead
// of after a round trip that reports `violates check constraint "employees_pan_format"`.
//
// The database normalises before it checks (app.tg_employee_normalise): PAN and IFSC are
// uppercased with whitespace stripped, Aadhaar and UAN keep only their digits. These functions
// normalise the same way, so whatever passes here is exactly what passes there — a PAN typed in
// lower case is accepted by both, not by one and rejected by the other.
//
// No imports on purpose: the test runner cannot load anything that reaches Supabase.

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const TWELVE_DIGITS = /^[0-9]{12}$/;
const GENDERS = ['Male', 'Female', 'Other'];

const upperNoSpace = (v) => String(v ?? '').replace(/\s/g, '').toUpperCase();
const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');
const noSpace = (v) => String(v ?? '').replace(/\s/g, '');

/** The values as the database will actually store them, given the same input. */
export function normaliseEmployeeFields(form) {
  return {
    ...form,
    pan: upperNoSpace(form?.pan),
    bank_ifsc: upperNoSpace(form?.bank_ifsc),
    aadhaar: digitsOnly(form?.aadhaar),
    uan: digitsOnly(form?.uan),
    bank_account: noSpace(form?.bank_account),
  };
}

/**
 * Is this date of birth inside the range the constraint allows?
 *
 * The check is `dob < today - 14 years and dob > today - 100 years`, both strict, so it is
 * expressed here as date comparisons rather than an age in years — an age rounds, and rounding is
 * how a client and a database come to disagree about the same birthday.
 *
 * Returns true, false, or null when the value is not a date at all.
 */
export function dobWithinRange(iso, today = new Date()) {
  if (!iso) return true;
  const dob = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();

  // Date.UTC rolls an impossible day forward — Date.UTC(2010, 1, 29) is 1 March 2010 — whereas
  // Postgres clamps: date '2024-02-29' - interval '14 years' is 2010-02-28. On 29 February the two
  // disagree by a day, and the client would accept a birth date the database then rejects. Clamp
  // to the last real day of the target month so both answer the same question.
  const clampDay = (year) => Math.min(d, new Date(Date.UTC(year, m + 1, 0)).getUTCDate());
  const oldest = Date.UTC(y - 100, m, clampDay(y - 100));
  const youngest = Date.UTC(y - 14, m, clampDay(y - 14));
  return dob.getTime() > oldest && dob.getTime() < youngest;
}

/**
 * Every format problem in the form, keyed by field. An empty object means the database will not
 * reject this on format grounds. Blank values are always fine — every one of these columns is
 * nullable, and completeness is reported elsewhere rather than enforced here.
 */
export function validateEmployeeFields(form, today = new Date()) {
  const v = normaliseEmployeeFields(form ?? {});
  const errors = {};

  if (v.pan && !PAN.test(v.pan)) {
    errors.pan = 'PAN looks wrong. It is five letters, four digits, then one letter — like AAAPZ1234C.';
  }
  if (v.bank_ifsc && !IFSC.test(v.bank_ifsc)) {
    errors.bank_ifsc = 'IFSC looks wrong. It is four letters, then a zero, then six letters or digits — like SBIN0001234.';
  }
  if (v.aadhaar && !TWELVE_DIGITS.test(v.aadhaar)) {
    errors.aadhaar = `Aadhaar must be exactly 12 digits — this one has ${v.aadhaar.length}.`;
  }
  if (v.uan && !TWELVE_DIGITS.test(v.uan)) {
    errors.uan = `UAN must be exactly 12 digits — this one has ${v.uan.length}. A PF number is a different thing and goes in its own field.`;
  }
  if (v.gender && !GENDERS.includes(v.gender)) {
    errors.gender = 'Gender must be Male, Female or Other.';
  }

  const dobOk = dobWithinRange(v.date_of_birth, today);
  if (dobOk === null) {
    errors.date_of_birth = 'Date of birth is not a date.';
  } else if (!dobOk) {
    errors.date_of_birth = 'Date of birth has to put this person between 14 and 100 years old. Check the year.';
  }

  return errors;
}
