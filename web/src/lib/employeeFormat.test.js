// These assert the client agrees with migration 0047. If a guard there changes and this does not,
// a save starts failing with a 400 again and nobody can see why from the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEmployeeFields, normaliseEmployeeFields, dobWithinRange } from './employeeFormat.js';

// Fixed so the age assertions do not drift with the calendar.
const TODAY = new Date('2026-08-05T00:00:00Z');

test('a blank form has nothing wrong with it — every one of these columns is nullable', () => {
  assert.deepEqual(validateEmployeeFields({}, TODAY), {});
  assert.deepEqual(validateEmployeeFields({ pan: '', aadhaar: '', uan: '', bank_ifsc: '' }, TODAY), {});
});

test('a PAN typed in lower case passes, because the database uppercases before it checks', () => {
  assert.deepEqual(validateEmployeeFields({ pan: 'aaapz1234c' }, TODAY), {});
  assert.equal(normaliseEmployeeFields({ pan: 'aaapz1234c' }).pan, 'AAAPZ1234C');
});

test('a PAN with the wrong shape is caught', () => {
  assert.ok(validateEmployeeFields({ pan: 'AAAP1234C' }, TODAY).pan);   // four letters
  assert.ok(validateEmployeeFields({ pan: 'AAAPZ1234' }, TODAY).pan);   // no trailing letter
  assert.ok(validateEmployeeFields({ pan: 'AAAPZ12345C' }, TODAY).pan); // five digits
});

test('Aadhaar and UAN are judged on their digits, not their spacing', () => {
  assert.deepEqual(validateEmployeeFields({ aadhaar: '4821 7734 9902' }, TODAY), {});
  assert.deepEqual(validateEmployeeFields({ uan: '1012-3456-7890' }, TODAY), {});
  assert.match(validateEmployeeFields({ aadhaar: '482177349' }, TODAY).aadhaar, /9/);
});

test('IFSC needs the reserved zero in the fifth position', () => {
  assert.deepEqual(validateEmployeeFields({ bank_ifsc: 'sbin0001234' }, TODAY), {});
  assert.ok(validateEmployeeFields({ bank_ifsc: 'SBIN1001234' }, TODAY).bank_ifsc);
  assert.ok(validateEmployeeFields({ bank_ifsc: 'SBI0001234' }, TODAY).bank_ifsc);
});

test('gender is limited to what the constraint allows', () => {
  assert.deepEqual(validateEmployeeFields({ gender: 'Female' }, TODAY), {});
  assert.ok(validateEmployeeFields({ gender: 'female' }, TODAY).gender);
});

test('a date of birth outside 14 to 100 years is a typo, not a fact', () => {
  assert.deepEqual(validateEmployeeFields({ date_of_birth: '1993-09-08' }, TODAY), {});
  assert.ok(validateEmployeeFields({ date_of_birth: '2020-01-01' }, TODAY).date_of_birth); // too young
  assert.ok(validateEmployeeFields({ date_of_birth: '1900-01-01' }, TODAY).date_of_birth); // too old
  assert.ok(validateEmployeeFields({ date_of_birth: '2030-01-01' }, TODAY).date_of_birth); // future
});

test('both bounds are strict, matching the SQL', () => {
  assert.equal(dobWithinRange('2012-08-05', TODAY), false); // exactly 14 today
  assert.equal(dobWithinRange('2012-08-04', TODAY), true);  // a day past 14
  assert.equal(dobWithinRange('1926-08-05', TODAY), false); // exactly 100 today
});

test('on 29 February the bound clamps like Postgres instead of rolling into March', () => {
  const leapDay = new Date('2024-02-29T00:00:00Z');
  // Postgres reads 2024-02-29 minus 14 years as 2010-02-28, so a birth date ON that day is not
  // strictly earlier than the bound and must be rejected — Date.UTC would have said 2010-03-01
  // and let it through.
  assert.equal(dobWithinRange('2010-02-28', leapDay), false);
  assert.ok(validateEmployeeFields({ date_of_birth: '2010-02-28' }, leapDay).date_of_birth);
  // A day either side still behaves.
  assert.equal(dobWithinRange('2010-02-27', leapDay), true);
});

test('an unparseable date says so rather than silently passing', () => {
  assert.equal(dobWithinRange('not-a-date', TODAY), null);
  assert.ok(validateEmployeeFields({ date_of_birth: 'not-a-date' }, TODAY).date_of_birth);
});

test('several problems are reported together, not one per save attempt', () => {
  const errors = validateEmployeeFields({ pan: 'NOPE', uan: '123', bank_ifsc: 'XX' }, TODAY);
  assert.deepEqual(Object.keys(errors).sort(), ['bank_ifsc', 'pan', 'uan']);
});
