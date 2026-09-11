import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as XLSX from 'xlsx';
import { readEmployeeSheet } from '../lib/employeeSpreadsheet.js';

let server, importer;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  importer = await server.ssrLoadModule('/src/data/employeeImport.js');
});
after(async () => { await server?.close(); });

test('Excel calendar dates retain the sheet day in the local timezone', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Employee Name', 'Join Date', 'Date of Birth'],
    ['Synthetic person', new Date(2026, 8, 1), new Date(2000, 1, 29)],
  ]), 'Employees');
  const rows = readEmployeeSheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const [person] = importer.extractPeople(rows, importer.detectLayout(rows));
  assert.equal(person.join_date, '2026-09-01');
  assert.equal(person.date_of_birth, '2000-02-29');
});

test('invalid calendar strings never produce impossible import dates', () => {
  const rows = [['Employee Name', 'Join Date', 'Date of Birth'],
    ['Synthetic person', '31/02/2026', '2025-02-29']];
  assert.throws(() => importer.extractPeople(rows, importer.detectLayout(rows)), /Invalid join date.*row 2/i);
  rows[1][1] = '01/09/2026';
  assert.throws(() => importer.extractPeople(rows, importer.detectLayout(rows)), /Invalid date of birth.*row 2/i);
});

for (const bookType of ['xlsx', 'xls', 'csv']) {
  test(`${bookType}: 525 employee import retains names, zero-prefixed codes, contact details and dates`, () => {
    const rows = [['Synthetic QA Company'], ['Employee Name', 'Employee Code', 'Branch', 'Phone', 'Join Date'],
      ...Array.from({ length: 525 }, (_, i) => [`Test Person ${i + 1}`, String(i + 1).padStart(6, '0'), 'B1', '0123456789', '2026-09-01'])];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Employees');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType });
    const data = readEmployeeSheet(bytes);
    const people = importer.extractPeople(data, importer.detectLayout(data));
    assert.equal(people.length, 525);
    assert.equal(people[0].employee_code, '000001');
    assert.equal(people[524].employee_code, '000525');
    assert.equal(people[524].full_name, 'Test Person 525');
    assert.equal(people[0].phone, '0123456789');
    assert.equal(people[0].join_date, '2026-09-01');
    const plan = importer.planImport(people, { existingByName: new Map(), existingByCode: new Map(),
      branches: new Set(['B1']), designations: new Set() });
    assert.equal(plan.rows.filter((r) => r.status === 'new').length, 525);
  });
}
