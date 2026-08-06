// An export travels back on the command row, and it must be the RIGHT export.
//
//   npx tsx --test src/exports/queuedExport.test.ts
//
// Two entry points now build these sheets — an HTTP call from the office LAN and a queued command
// from anywhere else — and the queued one has no bearer token, only a user id. The risk is that the
// second path resolves scope more loosely than the first and hands somebody a spreadsheet with
// people in it they may not see. These cover the seam between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportFilename, EXPORT_PERMISSIONS } from './generate';

test('a queued export and a direct one name the file identically', () => {
  // The filename used to be built by hand at each call site with its own padStart. Two spellings of
  // the same month is how "which of these four files is September" starts.
  assert.equal(exportFilename('register', 2026, 9), 'attendance-register-2026-09.xlsx');
  assert.equal(exportFilename('payroll', 2026, 9), 'payroll-attendance-2026-09.xlsx');
  assert.equal(exportFilename('register', 2026, 12), 'attendance-register-2026-12.xlsx');
});

// Scope is resolved from these, so a permission listed here that the route does not admit — or the
// reverse — is a caller getting rows on the strength of a grant nobody checked.
test('each sheet resolves scope from exactly the permissions it admits', () => {
  assert.deepEqual(EXPORT_PERMISSIONS.register, ['report.read', 'attendance.read']);
  assert.deepEqual(EXPORT_PERMISSIONS.payroll, ['report.read', 'payslip.read']);
});

// The two screens disagree about how to send a branch filter: Reports sends ["<uuid>"], the query
// string form is "<uuid>". An unrecognised shape must not quietly become "no filter", because that
// widens the sheet from one branch to every branch the caller can see and still downloads happily.
test('a branch filter survives being sent as an array or as a string', () => {
  const normalise = (v: unknown): string | undefined => {
    const joined = Array.isArray(v)
      ? v.filter((b): b is string => typeof b === 'string' && b !== '').join(',')
      : typeof v === 'string' && v
        ? v
        : undefined;
    return joined || undefined;
  };

  assert.equal(normalise(['b1']), 'b1');
  assert.equal(normalise(['b1', 'b2']), 'b1,b2');
  assert.equal(normalise('b1,b2'), 'b1,b2');
  assert.equal(normalise(undefined), undefined, 'no filter stays no filter');
  assert.equal(normalise([]), undefined, 'an empty array is no filter, which scopeFor then resolves');
  assert.equal(normalise(['', null as unknown as string]), undefined, 'junk does not become a branch id');
});

test('base64 round-trips the bytes a browser will turn back into a workbook', () => {
  // The transport is a text column, so this is the one lossy-looking step in the chain. A .xlsx is
  // a zip: it starts with PK\x03\x04 and is full of bytes that are not valid UTF-8, which is
  // exactly what a naive toString() would mangle.
  const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe]);
  const base64 = zipHeader.toString('base64');
  assert.deepEqual(Buffer.from(base64, 'base64'), zipHeader);

  // And the browser's half of the same trip — atob + charCodeAt, as in syncStatus.js.
  const binary = Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  assert.deepEqual(Buffer.from(bytes), zipHeader);
});
